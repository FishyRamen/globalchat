// server.js (ESM) — Render-ready, disk-ready persistence, invites-required groups, XP saved per user
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

app.use(express.static("public"));

/**
 * -------------------------
 * Persistence (Render disk-ready)
 * -------------------------
 * If you add a Render Persistent Disk mounted at /data,
 * this will automatically store to: /data/tonkotsu.json
 */
const DISK_FILE = process.env.TONKOTSU_DB_FILE || "/data/tonkotsu.json";

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveToDisk().catch(() => {});
  }, 700);
}

function safeJson(obj) {
  return JSON.stringify(obj, null, 2);
}

// ---------------- In-memory DB (with disk load/save) ----------------
const db = {
  users: {},        // username -> user record
  tokens: {},       // token -> username
  global: [],       // [{user,text,ts}]
  dms: {},          // "a|b" -> [{user,text,ts}]
  groups: {},       // gid -> {id,name,owner,members:[...], msgs:[...], active:boolean, pendingInvites:[...]}
  groupInvites: {}  // username -> [{groupId, from, groupName, ts}]
};

function normalizeUser(u) { return String(u || "").trim(); }
function dmKey(a, b) {
  const x = String(a), y = String(b);
  return (x.localeCompare(y) <= 0) ? `${x}|${y}` : `${y}|${x}`;
}
function now() { return Date.now(); }

function usernameValid(u) {
  // no spaces, only letters/numbers/_/.
  return /^[A-Za-z0-9_.]{3,20}$/.test(u);
}

// Keep it strict for "weird 18+ stuff" + heavy slur list request.
// NOTE: we do NOT include slurs explicitly in code here; we use pattern categories instead.
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
  /\b(i('?m| am)?\s+going\s+to\s+kill|i('?m| am)?\s+gonna\s+kill)\b/i,
  /\b(send\s+nudes|nude\s+pics)\b/i,
  /\b(dox|doxx|address|phone\s*number)\b/i
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

// XP model
function xpNext(level) {
  const base = 120;
  const growth = Math.floor(base * Math.pow(Math.max(1, level), 1.5));
  return Math.max(base, growth);
}
function addXP(userRec, amount) {
  if (!userRec || userRec.guest) return;
  if (!userRec.xp) userRec.xp = { level: 1, xp: 0, next: xpNext(1) };
  userRec.xp.xp += amount;

  while (userRec.xp.xp >= userRec.xp.next) {
    userRec.xp.xp -= userRec.xp.next;
    userRec.xp.level += 1;
    userRec.xp.next = xpNext(userRec.xp.level);
  }
}

// Create/get user
function ensureUser(username, password) {
  if (!db.users[username]) {
    db.users[username] = {
      username,
      pass: hashPass(password),
      createdAt: now(),
      guest: false,
      settings: {
        theme: "dark",
        density: 0.15,        // compact default
        sidebar: 0.22,        // narrow default
        hideMildProfanity: false,
        customCursor: true,   // MATCHES frontend
        pingSound: true,      // MATCHES frontend
        pingVolume: 0.45      // MATCHES frontend
      },
      social: {
        friends: [],
        incoming: [],
        outgoing: [],
        blocked: []
      },
      stats: { messages: 0 },
      xp: { level: 1, xp: 0, next: xpNext(1) }
    };
  }
  return db.users[username];
}

function publicProfile(username) {
  const u = db.users[username];
  if (!u) return null;
  if (u.guest) return { user: username, guest: true };
  return {
    user: username,
    guest: false,
    createdAt: u.createdAt,
    level: u.xp?.level ?? 1,
    xp: u.xp?.xp ?? 0,
    next: u.xp?.next ?? xpNext(1),
    messages: u.stats?.messages ?? 0,
    friendsCount: u.social?.friends?.length ?? 0
  };
}

// Online tracking
const socketToUser = new Map(); // socket.id -> username
const online = new Set();

function emitOnline() {
  const list = Array.from(online).sort().map(user => ({ user }));
  io.emit("onlineUsers", list);
}

function getInvites(username) {
  return db.groupInvites[username] || [];
}

// Messages ping count (non-global)
function computeMessagePing(username) {
  // Simple model: count of pending friend requests + group invites
  // + you can extend later with unread per DM/group.
  const u = db.users[username];
  if (!u || u.guest) return 0;
  return (u.social?.incoming?.length || 0) + (getInvites(username).length || 0);
}

function emitPing(username) {
  const u = db.users[username];
  if (!u || u.guest) return;
  io.to(username).emit("ping:update", { messages: computeMessagePing(username) });
}

function emitSocial(username) {
  const u = db.users[username];
  if (!u || u.guest) return;

  io.to(username).emit("social:update", {
    ...u.social,
    groupInvites: getInvites(username)
  });

  emitPing(username);
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

// Disk load/save
async function loadFromDisk() {
  try {
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
    }
    console.log("[db] loaded", DISK_FILE);
  } catch (e) {
    console.log("[db] load failed", e?.message || e);
  }
}
async function saveToDisk() {
  try {
    const dir = path.dirname(DISK_FILE);
    if (!fs.existsSync(dir)) return; // no disk mounted
    const payload = {
      users: db.users,
      tokens: db.tokens,
      global: db.global,
      dms: db.dms,
      groups: db.groups,
      groupInvites: db.groupInvites
    };
    await fs.promises.writeFile(DISK_FILE, safeJson(payload), "utf8");
  } catch {
    // ignore
  }
}

await loadFromDisk();

// ---------------- Socket events ----------------
io.on("connection", (socket) => {
  function currentUser() {
    return socketToUser.get(socket.id) || null;
  }
  function isGuestUserName(name) {
    return /^Guest\d{4,5}$/.test(String(name));
  }
  function requireAuth() {
    const u = currentUser();
    if (!u) return null;
    if (isGuestUserName(u)) return null;
    return u;
  }

  function attachUser(username) {
    socketToUser.set(socket.id, username);
    socket.join(username);
    online.add(username);
    emitOnline();
  }

  socket.on("resume", ({ token } = {}) => {
    const t = String(token || "");
    const username = db.tokens[t];
    if (!username || !db.users[username]) {
      socket.emit("resumeFail");
      return;
    }

    attachUser(username);

    const userRec = db.users[username];
    socket.emit("loginSuccess", {
      username,
      guest: false,
      token: t,
      settings: userRec.settings,
      social: { ...userRec.social, groupInvites: getInvites(username) },
      xp: userRec.xp
    });

    socket.emit("settings", userRec.settings);
    socket.emit("xp:update", userRec.xp);
    emitSocial(username);
    emitGroupsList(username);
  });

  socket.on("login", ({ username, password, guest } = {}) => {
    if (guest) {
      // Guest ID must be 4 digits (frontend requests 4; allow 4-5 in regex)
      const digits = String(Math.floor(1000 + Math.random() * 9000)); // 4 digits
      const g = `Guest${digits}`;

      socketToUser.set(socket.id, g);
      online.add(g);
      emitOnline();

      socket.emit("loginSuccess", {
        username: g,
        guest: true,
        settings: {
          theme: "dark",
          density: 0.15,
          sidebar: 0.22,
          hideMildProfanity: false,
          customCursor: true,
          pingSound: true,
          pingVolume: 0.45
        },
        social: { friends: [], incoming: [], outgoing: [], blocked: [], groupInvites: [] },
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

    const existing = db.users[u];
    if (!existing) {
      ensureUser(u, p);
      scheduleSave();
    } else {
      if (!checkPass(p, existing.pass)) {
        socket.emit("loginError", "Wrong password.");
        return;
      }
    }

    const token = newToken();
    db.tokens[token] = u;

    attachUser(u);

    const userRec = db.users[u];
    socket.emit("loginSuccess", {
      username: u,
      guest: false,
      token,
      settings: userRec.settings,
      social: { ...userRec.social, groupInvites: getInvites(u) },
      xp: userRec.xp
    });

    socket.emit("settings", userRec.settings);
    socket.emit("xp:update", userRec.xp);
    emitSocial(u);
    emitGroupsList(u);
    scheduleSave();
  });

  socket.on("disconnect", () => {
    const u = currentUser();
    socketToUser.delete(socket.id);
    if (u) {
      online.delete(u);
      emitOnline();
    }
  });

  // Settings update (SAVE ONLY — client handles previews)
  socket.on("settings:update", (settings) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;

    const s = settings || {};
    u.settings = {
      theme: ["dark", "vortex", "abyss", "carbon"].includes(s.theme) ? s.theme : "dark",
      density: Number.isFinite(s.density) ? Math.max(0, Math.min(1, s.density)) : 0.15,
      sidebar: Number.isFinite(s.sidebar) ? Math.max(0, Math.min(1, s.sidebar)) : 0.22,
      hideMildProfanity: !!s.hideMildProfanity,
      customCursor: s.customCursor !== false,
      pingSound: s.pingSound !== false,
      pingVolume: Number.isFinite(s.pingVolume) ? Math.max(0, Math.min(1, s.pingVolume)) : 0.45
    };

    socket.emit("settings", u.settings);
    scheduleSave();
  });

  // Social sync
  socket.on("social:sync", () => {
    const username = requireAuth();
    if (!username) return;
    emitSocial(username);
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
    if (!p) {
      socket.emit("profile:data", { user: target, missing: true });
      return;
    }
    socket.emit("profile:data", p);
  });

  // Friend requests
  socket.on("friend:request", ({ to } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target]) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }
    if (target === username) {
      socket.emit("sendError", { reason: "You can’t friend yourself." });
      return;
    }

    const me = db.users[username];
    const them = db.users[target];

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      socket.emit("sendError", { reason: "Blocked." });
      return;
    }
    if (me.social.friends.includes(target)) {
      socket.emit("sendError", { reason: "Already friends." });
      return;
    }
    if (me.social.outgoing.includes(target)) {
      socket.emit("sendError", { reason: "Request already sent." });
      return;
    }

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

  // Block user
  socket.on("user:block", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(user);
    if (!db.users[target]) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }

    const me = db.users[username];
    if (!me.social.blocked.includes(target)) me.social.blocked.push(target);

    // remove friendship & pending
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

    if (!/^Guest/.test(sender) && db.users[sender]) {
      db.users[sender].stats.messages += 1;
      addXP(db.users[sender], 8);
      io.to(sender).emit("xp:update", db.users[sender].xp);
      scheduleSave();
    }
  });

  // DM history + send (respects blocking)
  socket.on("dm:history", ({ withUser } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const other = normalizeUser(withUser);
    if (!db.users[other]) {
      socket.emit("dm:history", { withUser: other, msgs: [] });
      return;
    }

    const key = dmKey(username, other);
    const msgs = (db.dms[key] || []).slice(-200);
    socket.emit("dm:history", { withUser: other, msgs });
  });

  socket.on("dm:send", ({ to, text } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target]) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }

    const me = db.users[username];
    const them = db.users[target];

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      socket.emit("sendError", { reason: "You can’t message this user." });
      return;
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: username, text: safeText, ts: now() };

    const key = dmKey(username, target);
    const list = getOrCreateDM(key);
    list.push(msg);
    if (list.length > 250) list.shift();

    // deliver:
    // receiver sees from: username
    io.to(target).emit("dm:message", { from: username, msg });
    // sender sees from: target (frontend expects this)
    io.to(username).emit("dm:message", { from: target, msg });

    me.stats.messages += 1;
    addXP(me, 10);
    io.to(username).emit("xp:update", me.xp);

    emitPing(username);
    emitPing(target);
    scheduleSave();
  });

  /**
   * Groups (invites REQUIRED):
   * - Frontend emits: group:createWithInvites {name, invites} with invites >=2
   * - Group is created "pending", becomes active when anyone accepts invite
   * - Invites appear in social:update.groupInvites
   */
  socket.on("groups:list", () => {
    const username = requireAuth();
    if (!username) return;
    emitGroupsList(username);
  });

  socket.on("group:createWithInvites", ({ name, invites } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const list = Array.isArray(invites) ? invites.map(normalizeUser) : [];
    const uniqueInvites = Array.from(new Set(list))
      .filter(u => u && u !== username && db.users[u]);

    // frontend enforces 2+, but keep server strict too
    if (uniqueInvites.length < 2) {
      socket.emit("sendError", { reason: "Invite at least 2 people to create a group." });
      return;
    }

    const gname = String(name || "").trim().slice(0, 40) || "Unnamed Group";
    const gid = crypto.randomBytes(6).toString("hex");

    db.groups[gid] = {
      id: gid,
      name: gname,
      owner: username,
      members: [username], // owner only until accept
      msgs: [],
      active: false,
      pendingInvites: uniqueInvites
    };

    // push invite into each user's inbox
    for (const u of uniqueInvites) {
      if (!db.groupInvites[u]) db.groupInvites[u] = [];
      db.groupInvites[u].unshift({ groupId: gid, from: username, groupName: gname, ts: now() });
      db.groupInvites[u] = db.groupInvites[u].slice(0, 50);
      emitSocial(u);
    }

    socket.emit("group:requestCreated", { groupId: gid, name: gname, invites: uniqueInvites });
    emitPing(username);
    scheduleSave();
  });

  // Accept/decline invite (frontend event names)
  socket.on("group:invite:accept", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g) return;

    // remove invite from inbox
    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.groupId !== gid);

    if (!g.members.includes(username)) g.members.push(username);
    if (!g.active) g.active = true;
    g.pendingInvites = (g.pendingInvites || []).filter(x => x !== username);

    // notify members + refresh lists
    for (const member of g.members) {
      io.to(member).emit("group:meta", {
        groupId: gid,
        meta: { id: gid, name: g.name, owner: g.owner, members: g.members }
      });
      emitGroupsList(member);
      emitSocial(member);
    }

    scheduleSave();
  });

  socket.on("group:invite:decline", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (g?.pendingInvites) g.pendingInvites = g.pendingInvites.filter(x => x !== username);

    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.groupId !== gid);
    emitSocial(username);
    scheduleSave();
  });

  socket.on("group:history", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) {
      socket.emit("sendError", { reason: "No access to group." });
      return;
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
      socket.emit("sendError", { reason: "No access to group." });
      return;
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: username, text: safeText, ts: now() };
    g.msgs.push(msg);
    if (g.msgs.length > 350) g.msgs.shift();

    for (const member of g.members) {
      io.to(member).emit("group:message", { groupId: gid, msg });
      emitPing(member);
    }

    const me = db.users[username];
    me.stats.messages += 1;
    addXP(me, 9);
    io.to(username).emit("xp:update", me.xp);

    scheduleSave();
  });

  socket.on("group:addMember", ({ groupId, user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const target = normalizeUser(user);
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can add members." });
      return;
    }
    if (!db.users[target]) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }
    if (!g.members.includes(target)) g.members.push(target);

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
      emitPing(m);
    }

    scheduleSave();
  });

  socket.on("group:removeMember", ({ groupId, user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const target = normalizeUser(user);
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can remove members." });
      return;
    }
    if (target === g.owner) {
      socket.emit("sendError", { reason: "Owner can’t be removed." });
      return;
    }

    g.members = g.members.filter(x => x !== target);

    io.to(target).emit("group:left", { groupId: gid });

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
      emitPing(m);
    }
    emitGroupsList(target);
    emitPing(target);

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
        emitPing(m);
      }
      scheduleSave();
      return;
    }

    g.members = g.members.filter(x => x !== username);
    io.to(username).emit("group:left", { groupId: gid });

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
      emitPing(m);
    }
    emitGroupsList(username);
    emitPing(username);

    scheduleSave();
  });

  socket.on("group:delete", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can delete group." });
      return;
    }

    const members = [...g.members];
    delete db.groups[gid];
    for (const m of members) {
      io.to(m).emit("group:deleted", { groupId: gid });
      emitGroupsList(m);
      emitPing(m);
    }
    scheduleSave();
  });

  socket.on("group:transferOwner", ({ groupId, newOwner } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const target = normalizeUser(newOwner);
    const g = db.groups[gid];

    if (!g || !g.active || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can transfer." });
      return;
    }
    if (!g.members.includes(target)) {
      socket.emit("sendError", { reason: "New owner must be a member." });
      return;
    }

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
    if (!g || !g.active || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can rename." });
      return;
    }

    const n = String(name || "").trim().slice(0, 40) || "Unnamed Group";
    g.name = n;

    for (const m of g.members) {
      io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
      emitGroupsList(m);
      emitPing(m);
    }
    scheduleSave();
  });

  // Optional: view:set for future unread tracking (frontend emits it)
  socket.on("view:set", () => {});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
