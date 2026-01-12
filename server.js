// server.js (ESM) — Render-ready + disk-ready persistence + XP + inbox mentions + groups invites required
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import process from "process";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static("public"));

/**
 * Persistent storage:
 * - Add a Render Persistent Disk mounted at /data
 * - This stores to /data/tonkotsu.json
 */
const DISK_FILE = process.env.TONKOTSU_DB_FILE || "/data/tonkotsu.json";
const DISK_DIR = path.dirname(DISK_FILE);
const CAN_PERSIST = fs.existsSync(DISK_DIR);

let saveTimer = null;
function scheduleSave() {
  if (!CAN_PERSIST) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveToDisk().catch(() => {});
  }, 700);
}

function safeJson(obj) {
  return JSON.stringify(obj, null, 2);
}

const db = {
  users: {},       // username -> user record
  tokens: {},      // token -> username
  global: [],      // [{user,text,ts}]
  dms: {},         // "a|b" -> [{user,text,ts}]
  groups: {},      // gid -> {id,name,owner,members,msgs,active,pendingInvites}
  groupInvites: {},// username -> [{id,from,name,ts}]
  inbox: {}        // username -> [{type,text,ts,meta}]
};

function now() { return Date.now(); }
function normalizeUser(u) { return String(u || "").trim(); }

function dmKey(a, b) {
  const x = String(a), y = String(b);
  return x.localeCompare(y) <= 0 ? `${x}|${y}` : `${y}|${x}`;
}

function usernameValid(u) {
  // 3-20 chars, letters/numbers/_/.
  return /^[A-Za-z0-9_.]{3,20}$/.test(u);
}

// Avoid embedding slur lists in code; block patterns for 18+/harmful naming
const USERNAME_BLOCK_PATTERNS = [
  /porn|onlyfans|nude|nsfw|sex|xxx/i,
  /child|minor|underage/i,
  /rape|rapist/i,
  /hitler|nazi/i
];

function badUsername(u) {
  const s = String(u || "");
  return USERNAME_BLOCK_PATTERNS.some(rx => rx.test(s));
}

// Hard filter for harmful messages: hide (not delete)
const HARD_BLOCK_PATTERNS = [
  /\b(kys|kill\s+yourself)\b/i,
  /\b(send\s+nudes|nude\s+pics)\b/i,
  /\b(dox|doxx)\b/i,
  /\b(address|phone\s*number)\b/i
];

function shouldHardHide(text) {
  const t = String(text || "");
  return HARD_BLOCK_PATTERNS.some(rx => rx.test(t));
}

// Password hashing
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.pbkdf2Sync(String(pw), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${derived}`;
}
function checkPass(pw, stored) {
  const [salt, derived] = String(stored || "").split(":");
  if (!salt || !derived) return false;
  const test = crypto.pbkdf2Sync(String(pw), salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(test), Buffer.from(derived));
}
function newToken() { return crypto.randomBytes(24).toString("hex"); }

// XP
function xpNext(level) {
  const base = 120;
  const growth = Math.floor(base * Math.pow(Math.max(1, level), 1.5));
  return Math.max(base, growth);
}
function addXP(userRec, amount) {
  if (!userRec || userRec.guest) return { leveledUp: false };
  if (!userRec.xp) userRec.xp = { level: 1, xp: 0, next: xpNext(1) };

  let leveledUp = false;
  userRec.xp.xp += amount;

  while (userRec.xp.xp >= userRec.xp.next) {
    userRec.xp.xp -= userRec.xp.next;
    userRec.xp.level += 1;
    userRec.xp.next = xpNext(userRec.xp.level);
    leveledUp = true;
  }
  return { leveledUp };
}

function ensureInbox(username) {
  if (!db.inbox[username]) db.inbox[username] = [];
  return db.inbox[username];
}
function pushInbox(username, item) {
  if (!db.users[username] || db.users[username].guest) return;
  const list = ensureInbox(username);
  list.unshift(item);
  db.inbox[username] = list.slice(0, 80);
  emitInboxCounts(username);
}

function emitInboxCounts(username) {
  const u = db.users[username];
  if (!u || u.guest) return;

  const invites = db.groupInvites[username] || [];
  const friends = u.social?.incoming || [];
  const mentions = db.inbox[username] || [];

  const count = (invites.length + friends.length + mentions.length) | 0;
  io.to(username).emit("inbox:update", {
    count,
    mentions: mentions.length,
    invites: invites.length,
    friendRequests: friends.length
  });
}

function ensureUser(username, password) {
  if (!db.users[username]) {
    db.users[username] = {
      username,
      pass: hashPass(password),
      createdAt: now(),
      guest: false,
      tutorialDone: false,
      bio: "",
      settings: {
        reduceMotion: false,
        cursorMode: "trail", // off | smooth | trail
        sounds: true,
        hideMildProfanity: false,
        revealBlockedGlobal: false
      },
      social: {
        friends: [],
        incoming: [],
        outgoing: [],
        blocked: []
      },
      stats: {
        messages: 0
      },
      xp: { level: 1, xp: 0, next: xpNext(1) },
      mutes: { dms: [], groups: [] }
    };
  }
  if (!db.inbox[username]) db.inbox[username] = [];
  if (!db.groupInvites[username]) db.groupInvites[username] = [];
  return db.users[username];
}

function publicProfile(username) {
  if (/^Guest\d{4,5}$/.test(username)) return { user: username, guest: true };

  const u = db.users[username];
  if (!u) return null;

  return {
    user: username,
    guest: false,
    createdAt: u.createdAt,
    bio: u.bio || "",
    level: u.xp?.level ?? 1,
    xp: u.xp?.xp ?? 0,
    next: u.xp?.next ?? xpNext(1),
    messages: u.stats?.messages ?? 0
  };
}

// Online tracking
const socketToUser = new Map(); // socket.id -> username
const online = new Set();

function emitOnline() {
  const list = Array.from(online).sort().map(user => ({ user }));
  io.emit("onlineUsers", list);
}

function emitSocial(username) {
  const u = db.users[username];
  if (!u || u.guest) return;
  io.to(username).emit("social:update", u.social);
  emitInboxCounts(username);
}

function emitGroupsList(username) {
  const u = db.users[username];
  if (!u || u.guest) return;

  const groups = Object.values(db.groups)
    .filter(g => g.active && g.members.includes(username))
    .map(g => ({ id: g.id, name: g.name, owner: g.owner, members: g.members }));

  io.to(username).emit("groups:list", groups);
}

function getOrCreateDM(key) {
  if (!db.dms[key]) db.dms[key] = [];
  return db.dms[key];
}

function computeLeaderboard(limit = 25) {
  const rows = Object.values(db.users)
    .filter(u => u && !u.guest && u.xp && typeof u.xp.level === "number")
    .map(u => ({
      user: u.username,
      level: u.xp.level,
      xp: u.xp.xp,
      next: u.xp.next,
      messages: u.stats?.messages ?? 0
    }))
    .sort((a, b) => (b.level - a.level) || (b.xp - a.xp) || (b.messages - a.messages))
    .slice(0, limit);
  return rows;
}

// Disk load/save
async function loadFromDisk() {
  try {
    if (!CAN_PERSIST) return;
    if (!fs.existsSync(DISK_FILE)) return;
    const raw = await fs.promises.readFile(DISK_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (parsed && typeof parsed === "object") {
      db.users = parsed.users || db.users;
      db.tokens = parsed.tokens || {};
      db.global = parsed.global || [];
      db.dms = parsed.dms || {};
      db.groups = parsed.groups || {};
      db.groupInvites = parsed.groupInvites || {};
      db.inbox = parsed.inbox || {};
    }
    console.log("[db] loaded", DISK_FILE);
  } catch (e) {
    console.log("[db] load failed", e?.message || e);
  }
}
async function saveToDisk() {
  try {
    if (!CAN_PERSIST) return;
    const payload = {
      users: db.users,
      tokens: db.tokens,
      global: db.global,
      dms: db.dms,
      groups: db.groups,
      groupInvites: db.groupInvites,
      inbox: db.inbox
    };
    await fs.promises.writeFile(DISK_FILE, safeJson(payload), "utf8");
  } catch {
    // ignore
  }
}

await loadFromDisk();

// Mention parsing (very simple, safe)
function extractMentions(text) {
  const s = String(text || "");
  const matches = s.match(/@([A-Za-z0-9_.]{3,20})/g) || [];
  const names = matches.map(m => m.slice(1));
  return Array.from(new Set(names));
}

io.on("connection", (socket) => {
  function currentUser() {
    return socketToUser.get(socket.id) || null;
  }
  function isGuestName(name) {
    return /^Guest\d{4,5}$/.test(String(name));
  }
  function requireAuth() {
    const u = currentUser();
    if (!u) return null;
    if (isGuestName(u)) return null;
    return u;
  }

  socket.on("resume", ({ token } = {}) => {
    const t = String(token || "");
    const username = db.tokens[t];
    if (!username || !db.users[username]) {
      socket.emit("resumeFail");
      return;
    }

    socketToUser.set(socket.id, username);
    socket.join(username);
    online.add(username);
    emitOnline();

    const userRec = db.users[username];

    socket.emit("loginSuccess", {
      username,
      guest: false,
      token: t,
      isNew: false,
      tutorialDone: !!userRec.tutorialDone,
      settings: userRec.settings,
      social: userRec.social,
      xp: userRec.xp
    });

    socket.emit("settings", userRec.settings);
    socket.emit("xp:update", userRec.xp);
    emitSocial(username);
    emitGroupsList(username);
    io.to(username).emit("leaderboard:data", computeLeaderboard());
  });

  socket.on("login", ({ username, password, guest } = {}) => {
    if (guest) {
      const digits = (Math.random() < 0.5)
        ? String(Math.floor(1000 + Math.random() * 9000))
        : String(Math.floor(10000 + Math.random() * 90000));
      const g = `Guest${digits}`;

      socketToUser.set(socket.id, g);
      online.add(g);
      emitOnline();

      socket.emit("loginSuccess", {
        username: g,
        guest: true,
        token: null,
        isNew: false,
        tutorialDone: true,
        settings: {
          reduceMotion: false,
          cursorMode: "trail",
          sounds: true,
          hideMildProfanity: false,
          revealBlockedGlobal: false
        },
        social: { friends: [], incoming: [], outgoing: [], blocked: [] },
        xp: null
      });
      return;
    }

    const u = normalizeUser(username);
    const p = String(password || "");

    if (!usernameValid(u) || badUsername(u)) {
      socket.emit("loginError", "Username not allowed. Use letters/numbers/_/. only (3-20). No spaces.");
      return;
    }
    if (!p || p.length < 4) {
      socket.emit("loginError", "Password too short.");
      return;
    }

    let isNew = false;
    const existing = db.users[u];
    if (!existing) {
      ensureUser(u, p);
      isNew = true;
      scheduleSave();
    } else {
      if (!checkPass(p, existing.pass)) {
        socket.emit("loginError", "Wrong password.");
        return;
      }
    }

    const token = newToken();
    db.tokens[token] = u;

    socketToUser.set(socket.id, u);
    socket.join(u);
    online.add(u);
    emitOnline();

    const userRec = db.users[u];

    socket.emit("loginSuccess", {
      username: u,
      guest: false,
      token,
      isNew,
      tutorialDone: !!userRec.tutorialDone,
      settings: userRec.settings,
      social: userRec.social,
      xp: userRec.xp
    });

    socket.emit("settings", userRec.settings);
    socket.emit("xp:update", userRec.xp);

    emitSocial(u);
    emitGroupsList(u);
    io.to(u).emit("leaderboard:data", computeLeaderboard());
    scheduleSave();
  });

  socket.on("logout", () => {
    const u = currentUser();
    if (!u) return;
    socket.leave(u);
    socketToUser.delete(socket.id);
    online.delete(u);
    emitOnline();
  });

  socket.on("disconnect", () => {
    const u = currentUser();
    socketToUser.delete(socket.id);
    if (u) {
      online.delete(u);
      emitOnline();
    }
  });

  // Settings update (save)
  socket.on("settings:update", (settings) => {
    const username = requireAuth();
    if (!username) return;

    const u = db.users[username];
    if (!u) return;

    const s = settings || {};
    u.settings = {
      reduceMotion: !!s.reduceMotion,
      cursorMode: ["off", "smooth", "trail"].includes(s.cursorMode) ? s.cursorMode : "trail",
      sounds: s.sounds !== false,
      hideMildProfanity: !!s.hideMildProfanity,
      revealBlockedGlobal: !!s.revealBlockedGlobal
    };

    socket.emit("settings", u.settings);
    scheduleSave();
  });

  // Tutorial done flag
  socket.on("tutorial:setDone", ({ done } = {}) => {
    const username = requireAuth();
    if (!username) return;
    db.users[username].tutorialDone = !!done;
    scheduleSave();
  });

  // Bio
  socket.on("bio:set", ({ bio } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const b = String(bio || "").slice(0, 220);
    db.users[username].bio = b;
    scheduleSave();
  });

  // Profile
  socket.on("profile:get", ({ user } = {}) => {
    const target = normalizeUser(user);
    if (!target) return;

    if (/^Guest\d{4,5}$/.test(target)) {
      socket.emit("profile:data", { user: target, guest: true });
      return;
    }
    const p = publicProfile(target);
    if (!p) socket.emit("profile:data", { user: target, missing: true });
    else socket.emit("profile:data", p);
  });

  // Leaderboard
  socket.on("leaderboard:get", () => {
    socket.emit("leaderboard:data", computeLeaderboard());
  });

  // Social sync
  socket.on("social:sync", () => {
    const username = requireAuth();
    if (!username) return;
    emitSocial(username);
  });

  // Friend requests
  socket.on("friend:request", ({ to } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target]) return socket.emit("sendError", { reason: "User not found." });
    if (target === username) return socket.emit("sendError", { reason: "You can’t friend yourself." });

    const me = db.users[username];
    const them = db.users[target];

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      return socket.emit("sendError", { reason: "Blocked." });
    }
    if (me.social.friends.includes(target)) return socket.emit("sendError", { reason: "Already friends." });
    if (me.social.outgoing.includes(target)) return socket.emit("sendError", { reason: "Request already sent." });

    me.social.outgoing.push(target);
    them.social.incoming.push(username);

    emitSocial(username);
    emitSocial(target);
    scheduleSave();
  });

  socket.on("friend:accept", ({ from } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const src = normalizeUser(from);

    const me = db.users[username];
    const them = db.users[src];
    if (!them) return;

    me.social.incoming = me.social.incoming.filter(x => x !== src);
    them.social.outgoing = them.social.outgoing.filter(x => x !== username);

    if (!me.social.friends.includes(src)) me.social.friends.push(src);
    if (!them.social.friends.includes(username)) them.social.friends.push(username);

    emitSocial(username);
    emitSocial(src);
    scheduleSave();
  });

  socket.on("friend:decline", ({ from } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const src = normalizeUser(from);

    const me = db.users[username];
    const them = db.users[src];
    if (!them) return;

    me.social.incoming = me.social.incoming.filter(x => x !== src);
    them.social.outgoing = them.social.outgoing.filter(x => x !== username);

    emitSocial(username);
    emitSocial(src);
    scheduleSave();
  });

  socket.on("friend:remove", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const target = normalizeUser(user);

    const me = db.users[username];
    const them = db.users[target];
    if (!them) return;

    me.social.friends = me.social.friends.filter(x => x !== target);
    them.social.friends = them.social.friends.filter(x => x !== username);

    emitSocial(username);
    emitSocial(target);
    scheduleSave();
  });

  // Block
  socket.on("user:block", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const target = normalizeUser(user);

    if (!db.users[target]) return socket.emit("sendError", { reason: "User not found." });
    const me = db.users[username];
    if (!me.social.blocked.includes(target)) me.social.blocked.push(target);

    // remove friendships & pending
    me.social.friends = me.social.friends.filter(x => x !== target);
    me.social.incoming = me.social.incoming.filter(x => x !== target);
    me.social.outgoing = me.social.outgoing.filter(x => x !== target);

    const them = db.users[target];
    them.social.friends = them.social.friends.filter(x => x !== username);
    them.social.incoming = them.social.incoming.filter(x => x !== username);
    them.social.outgoing = them.social.outgoing.filter(x => x !== username);

    emitSocial(username);
    emitSocial(target);
    scheduleSave();
  });

  socket.on("user:unblock", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const target = normalizeUser(user);

    const me = db.users[username];
    me.social.blocked = me.social.blocked.filter(x => x !== target);

    emitSocial(username);
    scheduleSave();
  });

  // Global history + send
  socket.on("requestGlobalHistory", () => {
    socket.emit("history", db.global.slice(-200));
  });

  socket.on("sendGlobal", ({ text, ts } = {}) => {
    const sender = currentUser();
    if (!sender) return;

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: sender, text: safeText, ts: Number(ts) || now() };
    db.global.push(msg);
    if (db.global.length > 250) db.global.shift();

    io.emit("globalMessage", msg);

    // Mentions -> inbox (ignore guests + ignore if muted global mentions via settings later client-side)
    const mentions = extractMentions(safeText);
    for (const name of mentions) {
      if (db.users[name] && !db.users[name].guest && name !== sender) {
        pushInbox(name, {
          type: "mention",
          ts: now(),
          text: `${sender} mentioned you in Global Chat`,
          meta: { from: sender }
        });
      }
    }

    if (!isGuestName(sender) && db.users[sender]) {
      const u = db.users[sender];
      u.stats.messages += 1;
      const { leveledUp } = addXP(u, 8);
      io.to(sender).emit("xp:update", u.xp);
      if (leveledUp) io.to(sender).emit("xp:levelup", { level: u.xp.level });
      io.emit("leaderboard:data", computeLeaderboard());
      scheduleSave();
    }
  });

  // DM
  socket.on("dm:history", ({ withUser } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const other = normalizeUser(withUser);
    if (!db.users[other]) return socket.emit("dm:history", { withUser: other, msgs: [] });

    const key = dmKey(username, other);
    const msgs = (db.dms[key] || []).slice(-200);
    socket.emit("dm:history", { withUser: other, msgs });
  });

  socket.on("dm:send", ({ to, text } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target]) return socket.emit("sendError", { reason: "User not found." });

    const me = db.users[username];
    const them = db.users[target];

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      return socket.emit("sendError", { reason: "You can’t message this user." });
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: username, text: safeText, ts: now() };

    const key = dmKey(username, target);
    const list = getOrCreateDM(key);
    list.push(msg);
    if (list.length > 250) list.shift();

    io.to(username).emit("dm:message", { from: target, msg });
    io.to(target).emit("dm:message", { from: username, msg });

    me.stats.messages += 1;
    const { leveledUp } = addXP(me, 10);
    io.to(username).emit("xp:update", me.xp);
    if (leveledUp) io.to(username).emit("xp:levelup", { level: me.xp.level });
    io.emit("leaderboard:data", computeLeaderboard());

    scheduleSave();
  });

  // Groups list
  socket.on("groups:list", () => {
    const username = requireAuth();
    if (!username) return;
    emitGroupsList(username);
  });

  /**
   * Groups: invites-required to create
   * - Create request sends invites, group becomes active after first acceptance (=> 2 members)
   */
  socket.on("group:createRequest", ({ name, invites } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const list = Array.isArray(invites) ? invites.map(normalizeUser) : [];
    const uniqueInvites = Array.from(new Set(list))
      .filter(u => u && u !== username && db.users[u] && !db.users[u].guest);

    if (uniqueInvites.length < 1) {
      return socket.emit("sendError", { reason: "Invite at least 1 person to create a group." });
    }

    const gname = String(name || "").trim().slice(0, 40) || "Unnamed Group";
    const gid = crypto.randomBytes(6).toString("hex");

    db.groups[gid] = {
      id: gid,
      name: gname,
      owner: username,
      members: [username],
      msgs: [],
      active: false,
      pendingInvites: uniqueInvites
    };

    for (const u of uniqueInvites) {
      if (!db.groupInvites[u]) db.groupInvites[u] = [];
      db.groupInvites[u].unshift({ id: gid, from: username, name: gname, ts: now() });
      db.groupInvites[u] = db.groupInvites[u].slice(0, 50);

      emitInboxCounts(u);
    }

    socket.emit("group:requestCreated", { id: gid, name: gname, invites: uniqueInvites });
    scheduleSave();
  });

  // Inbox get
  socket.on("inbox:get", () => {
    const username = requireAuth();
    if (!username) return;

    const u = db.users[username];
    socket.emit("inbox:data", {
      mentions: db.inbox[username] || [],
      groupInvites: db.groupInvites[username] || [],
      friendRequests: u.social.incoming || []
    });

    emitInboxCounts(username);
  });

  socket.on("inbox:clearMentions", () => {
    const username = requireAuth();
    if (!username) return;
    db.inbox[username] = [];
    emitInboxCounts(username);
    scheduleSave();
  });

  // Group invite accept/decline
  socket.on("groupInvite:accept", ({ id } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(id || "");
    const g = db.groups[gid];
    if (!g) return;

    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.id !== gid);

    if (!g.members.includes(username)) g.members.push(username);

    if (!g.active) g.active = true; // first acceptance => now group has >=2 people
    g.pendingInvites = (g.pendingInvites || []).filter(x => x !== username);

    for (const member of g.members) {
      io.to(member).emit("group:meta", {
        groupId: gid,
        meta: { id: gid, name: g.name, owner: g.owner, members: g.members }
      });
      emitGroupsList(member);
    }
    emitInboxCounts(username);
    scheduleSave();
  });

  socket.on("groupInvite:decline", ({ id } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(id || "");
    const g = db.groups[gid];
    if (g?.pendingInvites) g.pendingInvites = g.pendingInvites.filter(x => x !== username);

    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.id !== gid);
    emitInboxCounts(username);
    scheduleSave();
  });

  socket.on("group:history", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) {
      return socket.emit("sendError", { reason: "No access to group." });
    }

    socket.emit("group:history", {
      groupId: gid,
      meta: { id: gid, name: g.name, owner: g.owner, members: g.members },
      msgs: g.msgs.slice(-250)
    });
  });

  socket.on("group:send", ({ groupId, text } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) {
      return socket.emit("sendError", { reason: "No access to group." });
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: username, text: safeText, ts: now() };
    g.msgs.push(msg);
    if (g.msgs.length > 350) g.msgs.shift();

    for (const member of g.members) {
      io.to(member).emit("group:message", { groupId: gid, msg });
    }

    // Mentions inside group -> inbox
    const mentions = extractMentions(safeText);
    for (const name of mentions) {
      if (db.users[name] && !db.users[name].guest && g.members.includes(name) && name !== username) {
        pushInbox(name, {
          type: "mention",
          ts: now(),
          text: `${username} mentioned you in Group: ${g.name}`,
          meta: { from: username, groupId: gid }
        });
      }
    }

    const me = db.users[username];
    me.stats.messages += 1;
    const { leveledUp } = addXP(me, 9);
    io.to(username).emit("xp:update", me.xp);
    if (leveledUp) io.to(username).emit("xp:levelup", { level: me.xp.level });
    io.emit("leaderboard:data", computeLeaderboard());

    scheduleSave();
  });

  // Group owner controls
  socket.on("group:addMember", ({ groupId, user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const target = normalizeUser(user);
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) {
      return socket.emit("sendError", { reason: "Only owner can invite." });
    }
    if (!db.users[target] || db.users[target].guest) {
      return socket.emit("sendError", { reason: "User not found." });
    }
    if (g.members.includes(target)) return;

    // send invite (join request)
    if (!db.groupInvites[target]) db.groupInvites[target] = [];
    db.groupInvites[target].unshift({ id: gid, from: username, name: g.name, ts: now() });
    db.groupInvites[target] = db.groupInvites[target].slice(0, 50);

    emitInboxCounts(target);
    scheduleSave();
  });

  socket.on("group:removeMember", ({ groupId, user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const target = normalizeUser(user);
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) {
      return socket.emit("sendError", { reason: "Only owner can remove members." });
    }
    if (target === g.owner) return socket.emit("sendError", { reason: "Owner can’t be removed." });

    g.members = g.members.filter(x => x !== target);
    io.to(target).emit("group:left", { groupId: gid });

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
    }
    emitGroupsList(target);
    scheduleSave();
  });

  socket.on("group:leave", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) return;

    if (g.owner === username) {
      const members = [...g.members];
      delete db.groups[gid];
      for (const m of members) {
        io.to(m).emit("group:deleted", { groupId: gid });
        emitGroupsList(m);
      }
      scheduleSave();
      return;
    }

    g.members = g.members.filter(x => x !== username);
    io.to(username).emit("group:left", { groupId: gid });

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
    }
    emitGroupsList(username);
    scheduleSave();
  });

  socket.on("group:delete", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || g.owner !== username) return socket.emit("sendError", { reason: "Only owner can delete." });

    const members = [...g.members];
    delete db.groups[gid];

    for (const m of members) {
      io.to(m).emit("group:deleted", { groupId: gid });
      emitGroupsList(m);
    }
    scheduleSave();
  });

  socket.on("group:transferOwner", ({ groupId, newOwner } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const target = normalizeUser(newOwner);
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) return socket.emit("sendError", { reason: "Only owner can transfer." });
    if (!g.members.includes(target)) return socket.emit("sendError", { reason: "New owner must be a member." });

    g.owner = target;
    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
    }
    scheduleSave();
  });

  socket.on("group:rename", ({ groupId, name } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) return socket.emit("sendError", { reason: "Only owner can rename." });

    const n = String(name || "").trim().slice(0, 40) || "Unnamed Group";
    g.name = n;

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
    }
    scheduleSave();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT, "| disk:", CAN_PERSIST ? DISK_FILE : "no /data"));


});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
