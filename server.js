// server.js (ESM) — Render-ready, persistence-ready, groups/invites, XP, statuses, bots, mentions
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

/**
 * Persistence (Render Persistent Disk mounted at /data)
 * Stores: /data/tonkotsu.json (or env TONKOTSU_DB_FILE)
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

function safeJson(obj) { return JSON.stringify(obj, null, 2); }
function now() { return Date.now(); }

const db = {
  users: {},        // username -> user record
  tokens: {},       // token -> username
  global: [],       // [{user,text,ts}]
  dms: {},          // "a|b" -> [{user,text,ts}]
  groups: {},       // gid -> group record
  groupInvites: {}  // username -> [{id, from, name, ts}]
};

function normalizeUser(u) { return String(u || "").trim(); }
function usernameValid(u) { return /^[A-Za-z0-9_.]{3,20}$/.test(u); }
function dmKey(a, b) {
  const x = String(a), y = String(b);
  return (x.localeCompare(y) <= 0) ? `${x}|${y}` : `${y}|${x}`;
}
function isGuestName(u) { return /^Guest\d{4,5}$/.test(String(u)); }

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

// Hard filter for obviously unsafe requests / dox / sexual solicitation etc.
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
  if (!userRec || userRec.guest) return { leveledUp: false };
  if (!userRec.xp) userRec.xp = { level: 1, xp: 0, next: xpNext(1) };

  const beforeLevel = userRec.xp.level;
  userRec.xp.xp += amount;

  while (userRec.xp.xp >= userRec.xp.next) {
    userRec.xp.xp -= userRec.xp.next;
    userRec.xp.level += 1;
    userRec.xp.next = xpNext(userRec.xp.level);
  }
  return { leveledUp: userRec.xp.level > beforeLevel };
}

function defaultSettings() {
  return {
    density: 0.15,         // compact
    sidebar: 0.24,         // compact sidebar
    cursorMode: "trail",   // off | normal | trail
    reduceAnimations: false,
    unblurBlocked: false,  // default blur blocked users’ messages
    sounds: true           // can be auto-muted by DND on client
  };
}

function ensureUser(username, password) {
  if (!db.users[username]) {
    db.users[username] = {
      username,
      pass: hashPass(password),
      createdAt: now(),
      guest: false,
      status: "online", // online|idle|dnd|invisible
      bio: "",
      settings: defaultSettings(),
      social: { friends: [], incoming: [], outgoing: [], blocked: [] },
      stats: { messages: 0 },
      xp: { level: 1, xp: 0, next: xpNext(1) },
      mutes: { global: false, dms: [], groups: [] }
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
    status: u.status || "online",
    bio: u.bio || "",
    level: u.xp?.level ?? 1,
    xp: u.xp?.xp ?? 0,
    next: u.xp?.next ?? xpNext(1),
    messages: u.stats?.messages ?? 0
  };
}

// Online tracking
const socketToUser = new Map(); // socket.id -> username
const online = new Set();       // tracks *currently connected* usernames (including bots)
const onlineHumanSockets = new Map(); // username -> count sockets

function isVisibleStatus(status) {
  return status !== "invisible";
}

function onlineListPayload() {
  // only show online users whose status is not invisible
  const arr = Array.from(online)
    .filter(u => {
      const rec = db.users[u];
      if (!rec) return true; // guests
      return isVisibleStatus(rec.status || "online");
    })
    .sort((a, b) => a.localeCompare(b))
    .map(user => {
      const rec = db.users[user];
      const status = rec?.status || "online";
      return { user, status, guest: isGuestName(user) || rec?.guest === true };
    });
  return arr;
}

function emitOnline() {
  io.emit("onlineUsers", onlineListPayload());
}

function emitSocial(username) {
  const u = db.users[username];
  if (!u || u.guest) return;
  io.to(username).emit("social:update", u.social);

  const invites = db.groupInvites[username] || [];
  io.to(username).emit("inbox:update", {
    friendRequests: u.social.incoming.length,
    groupInvites: invites.length,
    mentions: 0 // client tracks mention count locally; server is stateless for mentions
  });
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

/**
 * -------------------------
 * “Real” users chatter (bots) — server-side so all devices see same messages.
 * These accounts exist in db.users but cannot be logged into (login denied).
 * They also go online/offline occasionally.
 * -------------------------
 */
const SIM_USERS = [
  "oregon6767","theowner","zippyfn","mikachu","voidd","lilsam","xavier09",
  "idkbro","noxity","bruhmoment","sarahxoxo","jaylen","ghosted","vex",
  "kiraalt","honeybee","rariii","dylanw","senpaiish","baddieq","koji"
];

// Deny login for these names (you asked: "you cant log into them")
const SIM_SET = new Set(SIM_USERS);

const SIM_LINES = [
  "wsg chat", "tf is this", "lowkey clean", "bruh my wifi tweaking",
  "anyone here?", "this kinda fire ngl", "why does it feel like discord lite",
  "yo who made this", "im dead 💀", "nahh", "this cursor wild",
  "bro why is global so active", "idk i like it", "ok this is smooth",
  "how do i make an acc", "yo @%GUEST% u just click login",
  "brb", "gtg", "gotta go wash dishes rq", "ima go eat rq", "back soon",
  "this better not lag later", "im on mobile rn"
];

const SIM_GUESTS = () => {
  const n = (Math.random() < 0.5)
    ? String(Math.floor(1000 + Math.random() * 9000))
    : String(Math.floor(10000 + Math.random() * 90000));
  return `Guest${n}`;
};

function ensureSimAccount(name) {
  if (!db.users[name]) {
    db.users[name] = {
      username: name,
      pass: null,
      createdAt: now() - Math.floor(Math.random() * 1000 * 60 * 60 * 24 * 365), // within ~1yr
      guest: false,
      status: "online",
      bio: "",
      settings: defaultSettings(),
      social: { friends: [], incoming: [], outgoing: [], blocked: [] },
      stats: { messages: 0 },
      xp: { level: Math.floor(1 + Math.random() * 12), xp: 0, next: xpNext(1) },
      mutes: { global: false, dms: [], groups: [] }
    };
  }
}

function simGoOnline(name) {
  ensureSimAccount(name);
  db.users[name].status = "online";
  online.add(name);
  emitOnline();
}
function simGoOffline(name) {
  if (db.users[name]) db.users[name].status = "invisible";
  online.delete(name);
  emitOnline();
}

function simSendGlobalLine() {
  // pick online sim user or bring one online
  let activeSim = SIM_USERS.filter(u => online.has(u));
  if (activeSim.length < 5) {
    // bring a few online
    const pick = SIM_USERS[Math.floor(Math.random() * SIM_USERS.length)];
    simGoOnline(pick);
    activeSim = SIM_USERS.filter(u => online.has(u));
  }
  const user = activeSim[Math.floor(Math.random() * activeSim.length)];

  let text = SIM_LINES[Math.floor(Math.random() * SIM_LINES.length)];
  if (text.includes("%GUEST%")) {
    const g = SIM_GUESTS();
    text = text.replace("%GUEST%", g);
  }

  const msg = { user, text, ts: now() };
  db.global.push(msg);
  if (db.global.length > 350) db.global.shift();
  io.emit("globalMessage", msg);
}

function simPresenceTick() {
  // randomly send someone offline
  if (Math.random() < 0.28) {
    const onlineSims = SIM_USERS.filter(u => online.has(u));
    if (onlineSims.length > 6) {
      const who = onlineSims[Math.floor(Math.random() * onlineSims.length)];
      simGoOffline(who);
    }
  }
  // randomly bring someone online
  if (Math.random() < 0.45) {
    const who = SIM_USERS[Math.floor(Math.random() * SIM_USERS.length)];
    simGoOnline(who);
  }
}

setTimeout(() => {
  // seed presence + start chatting
  for (let i = 0; i < 9; i++) simGoOnline(SIM_USERS[i]);
  emitOnline();
  setInterval(simPresenceTick, 15000);
  setInterval(simSendGlobalLine, 9000);
}, 2500);

// ---------------- Socket events ----------------
io.on("connection", (socket) => {
  function currentUser() { return socketToUser.get(socket.id) || null; }

  function requireAuth() {
    const u = currentUser();
    if (!u) return null;
    if (isGuestName(u)) return null;
    return u;
  }

  function setOnlineForUser(u) {
    if (!u) return;
    online.add(u);
    const count = (onlineHumanSockets.get(u) || 0) + 1;
    onlineHumanSockets.set(u, count);
  }

  function clearOnlineForUser(u) {
    if (!u) return;
    const count = (onlineHumanSockets.get(u) || 0) - 1;
    if (count <= 0) {
      onlineHumanSockets.delete(u);
      if (!SIM_SET.has(u)) online.delete(u);
    } else {
      onlineHumanSockets.set(u, count);
    }
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

    setOnlineForUser(username);
    emitOnline();

    const userRec = db.users[username];
    socket.emit("loginSuccess", {
      username,
      guest: false,
      token: t,
      settings: userRec.settings || defaultSettings(),
      social: userRec.social,
      xp: userRec.xp,
      status: userRec.status || "online",
      bio: userRec.bio || ""
    });

    socket.emit("settings", userRec.settings || defaultSettings());
    socket.emit("xp:update", userRec.xp);
    socket.emit("status:update", { user: username, status: userRec.status || "online" });

    emitSocial(username);
    emitGroupsList(username);
    socket.emit("global:cooldown", { ms: 3000 });
  });

  socket.on("login", ({ username, password, guest } = {}) => {
    if (guest) {
      const digits = (Math.random() < 0.5)
        ? String(Math.floor(1000 + Math.random() * 9000))
        : String(Math.floor(10000 + Math.random() * 90000));
      const g = `Guest${digits}`;

      socketToUser.set(socket.id, g);
      socket.join(g);

      // Guests are online
      online.add(g);
      emitOnline();

      socket.emit("loginSuccess", {
        username: g,
        guest: true,
        token: null,
        settings: defaultSettings(),
        social: { friends: [], incoming: [], outgoing: [], blocked: [] },
        xp: null,
        status: "online",
        bio: ""
      });

      socket.emit("settings", defaultSettings());
      socket.emit("status:update", { user: g, status: "online" });
      socket.emit("global:cooldown", { ms: 5000 });
      return;
    }

    const u = normalizeUser(username);
    const p = String(password || "");

    if (!usernameValid(u) || badUsername(u)) {
      socket.emit("loginError", "Username not allowed. Use letters/numbers/_/. only (3-20). No spaces.");
      return;
    }
    if (SIM_SET.has(u)) {
      socket.emit("loginError", "That username is not available.");
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

    socketToUser.set(socket.id, u);
    socket.join(u);

    setOnlineForUser(u);
    // default visible status if invisible
    if (db.users[u].status === "invisible") db.users[u].status = "online";
    emitOnline();

    const userRec = db.users[u];
    socket.emit("loginSuccess", {
      username: u,
      guest: false,
      token,
      settings: userRec.settings || defaultSettings(),
      social: userRec.social,
      xp: userRec.xp,
      status: userRec.status || "online",
      bio: userRec.bio || ""
    });

    socket.emit("settings", userRec.settings || defaultSettings());
    socket.emit("xp:update", userRec.xp);
    socket.emit("status:update", { user: u, status: userRec.status || "online" });

    emitSocial(u);
    emitGroupsList(u);
    socket.emit("global:cooldown", { ms: 3000 });
    scheduleSave();
  });

  socket.on("logout", () => {
    const u = currentUser();
    if (!u) return;
    socketToUser.delete(socket.id);

    if (isGuestName(u)) {
      online.delete(u);
    } else {
      clearOnlineForUser(u);
    }
    emitOnline();
    socket.emit("loggedOut");
  });

  socket.on("disconnect", () => {
    const u = currentUser();
    socketToUser.delete(socket.id);

    if (u) {
      if (isGuestName(u)) online.delete(u);
      else clearOnlineForUser(u);
      emitOnline();
    }
  });

  // Settings update
  socket.on("settings:update", (settings) => {
    const username = requireAuth();
    if (!username) return;

    const u = db.users[username];
    if (!u) return;

    const s = settings || {};
    u.settings = {
      density: Number.isFinite(s.density) ? Math.max(0.05, Math.min(0.45, s.density)) : (u.settings?.density ?? 0.15),
      sidebar: Number.isFinite(s.sidebar) ? Math.max(0.18, Math.min(0.32, s.sidebar)) : (u.settings?.sidebar ?? 0.24),
      cursorMode: ["off", "normal", "trail"].includes(s.cursorMode) ? s.cursorMode : (u.settings?.cursorMode ?? "trail"),
      reduceAnimations: !!s.reduceAnimations,
      unblurBlocked: !!s.unblurBlocked,
      sounds: s.sounds !== false
    };

    socket.emit("settings", u.settings);
    scheduleSave();
  });

  // Status updates
  socket.on("status:set", ({ status } = {}) => {
    const username = currentUser();
    if (!username) return;

    // guests can change too (only local-ish effect; but broadcast status)
    const allowed = ["online", "idle", "dnd", "invisible"];
    const s = allowed.includes(String(status)) ? String(status) : "online";

    if (!isGuestName(username) && db.users[username]) {
      db.users[username].status = s;
      scheduleSave();
    }

    // if invisible, remove from list
    if (s === "invisible") {
      if (!SIM_SET.has(username)) online.delete(username);
    } else {
      online.add(username);
    }

    io.emit("status:update", { user: username, status: s });
    emitOnline();
  });

  // Profile
  socket.on("profile:get", ({ user } = {}) => {
    const target = normalizeUser(user);
    if (!target) return;

    if (isGuestName(target)) {
      socket.emit("profile:data", { user: target, guest: true, status: "online" });
      return;
    }

    const p = publicProfile(target);
    if (!p) {
      socket.emit("profile:data", { user: target, missing: true });
      return;
    }
    socket.emit("profile:data", p);
  });

  socket.on("profile:setBio", ({ bio } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;

    const b = String(bio || "").slice(0, 180);
    u.bio = b;
    socket.emit("profile:data", publicProfile(username));
    scheduleSave();
  });

  // Inbox: friend requests + group invites only (mentions handled client-side)
  socket.on("inbox:get", () => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];

    socket.emit("inbox:data", {
      friendRequests: u.social.incoming || [],
      groupInvites: db.groupInvites[username] || []
    });
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

  // Block / unblock
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
    socket.emit("history", db.global.slice(-250));
  });

  socket.on("sendGlobal", ({ text, ts } = {}) => {
    const sender = currentUser();
    if (!sender) return;

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: sender, text: safeText, ts: Number(ts) || now() };
    db.global.push(msg);
    if (db.global.length > 350) db.global.shift();

    io.emit("globalMessage", msg);

    if (!isGuestName(sender) && db.users[sender]) {
      db.users[sender].stats.messages += 1;
      const { leveledUp } = addXP(db.users[sender], 8);
      io.to(sender).emit("xp:update", { ...db.users[sender].xp, leveledUp });
      scheduleSave();
    }
  });

  // DM history + send
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

    io.to(username).emit("dm:message", { from: target, msg });
    io.to(target).emit("dm:message", { from: username, msg });

    me.stats.messages += 1;
    const { leveledUp } = addXP(me, 10);
    io.to(username).emit("xp:update", { ...me.xp, leveledUp });

    scheduleSave();
  });

  // Groups
  socket.on("groups:list", () => {
    const username = requireAuth();
    if (!username) return;
    emitGroupsList(username);
  });

  socket.on("group:createRequest", ({ name, invites } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const list = Array.isArray(invites) ? invites.map(normalizeUser) : [];
    const uniqueInvites = Array.from(new Set(list))
      .filter(u => u && u !== username && db.users[u]);

    if (uniqueInvites.length < 1) {
      socket.emit("sendError", { reason: "Invite at least 1 person to create a group." });
      return;
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
      emitSocial(u);
    }

    socket.emit("group:requestCreated", { id: gid, name: gname, invites: uniqueInvites });
    scheduleSave();
  });

  socket.on("groupInvite:accept", ({ id } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(id || "");
    const g = db.groups[gid];
    if (!g) return;

    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.id !== gid);

    if (!g.members.includes(username)) g.members.push(username);
    if (!g.active) g.active = true;
    g.pendingInvites = (g.pendingInvites || []).filter(x => x !== username);

    for (const member of g.members) {
      io.to(member).emit("group:meta", {
        groupId: gid,
        meta: { id: gid, name: g.name, owner: g.owner, members: g.members }
      });
      emitGroupsList(member);
    }

    emitSocial(username);
    scheduleSave();
  });

  socket.on("groupInvite:decline", ({ id } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(id || "");
    const g = db.groups[gid];
    if (g?.pendingInvites) g.pendingInvites = g.pendingInvites.filter(x => x !== username);
    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.id !== gid);

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

    for (const member of g.members) io.to(member).emit("group:message", { groupId: gid, msg });

    const me = db.users[username];
    me.stats.messages += 1;
    const { leveledUp } = addXP(me, 9);
    io.to(username).emit("xp:update", { ...me.xp, leveledUp });

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
    if (!g || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can delete group." });
      return;
    }

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

    if (!g || !g.active || g.owner !== username) {
      socket.emit("sendError", { reason: "Only owner can transfer." });
      return;
    }
    if (!g.members.includes(target)) {
      socket.emit("sendError", { reason: "New owner must be a member." });
      return;
    }

    g.owner = target;
    for (const m of g.members) io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members } });
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
    }
    scheduleSave();
  });

  // Leaderboard
  socket.on("leaderboard:get", () => {
    const rows = Object.values(db.users)
      .filter(u => u && !u.guest && !SIM_SET.has(u.username))
      .map(u => ({ user: u.username, level: u.xp?.level ?? 1, messages: u.stats?.messages ?? 0 }))
      .sort((a, b) => (b.level - a.level) || (b.messages - a.messages))
      .slice(0, 20);

    socket.emit("leaderboard:data", rows);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));
