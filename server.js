/**
 * tonkotsu.online — server.js
 * Express + Socket.IO + persistent JSON storage (data/)
 *
 * DATA PERSISTENCE:
 * - Create a folder named: data/
 * - Add a Render disk later mounted to: /opt/render/project/src/data
 */

"use strict";

const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ---------------------- persistence ---------------------- */
const DATA_DIR = path.join(__dirname, "data");
const FILES = {
  users: path.join(DATA_DIR, "users.json"),
  global: path.join(DATA_DIR, "global.json"),
  dms: path.join(DATA_DIR, "dms.json"),
  groups: path.join(DATA_DIR, "groups.json"),
  sessions: path.join(DATA_DIR, "sessions.json"),
};

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}
function ensureFile(file, fallback) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
}
function readJSON(file, fallback) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

ensureDir(DATA_DIR);
ensureFile(FILES.users, {});    // username -> { passwordHash, createdAt, settings, unread, friends, ... }
ensureFile(FILES.global, []);   // [{id,user,text,ts}]
ensureFile(FILES.dms, {});      // key "a|b" -> [{id,from,to,text,ts}]
ensureFile(FILES.groups, {});   // gid -> {id,name,owner,members[],messages[]}
ensureFile(FILES.sessions, {}); // token -> { user, createdAt }

let USERS = readJSON(FILES.users, {});
let GLOBAL = readJSON(FILES.global, []);
let DMS = readJSON(FILES.dms, {});
let GROUPS = readJSON(FILES.groups, {});
let SESSIONS = readJSON(FILES.sessions, {});

function saveAll() {
  writeJSON(FILES.users, USERS);
  writeJSON(FILES.global, GLOBAL);
  writeJSON(FILES.dms, DMS);
  writeJSON(FILES.groups, GROUPS);
  writeJSON(FILES.sessions, SESSIONS);
}

/* ---------------------- helpers ---------------------- */
const ONLINE = new Map();            // socket.id -> username
const USER_SOCKETS = new Map();      // username -> Set(socket.id)

function now() { return Date.now(); }
function genId() { return crypto.randomBytes(10).toString("hex") + "-" + now().toString(36); }
function norm(s) { return String(s || "").trim(); }

function hashPass(pw) {
  // simple salted hash for hobby use (still not "bcrypt secure", but better than plain)
  const salt = "tonkotsu_salt_v1";
  return crypto.createHash("sha256").update(salt + String(pw || "")).digest("hex");
}

function dmKey(a, b) {
  const x = String(a), y = String(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function isGuest(u) {
  return /^Guest\d{1,10}$/.test(String(u || ""));
}

function ensureUser(user) {
  if (!USERS[user]) return null;
  USERS[user].settings = USERS[user].settings || defaultSettings();
  USERS[user].unread = USERS[user].unread || { global: 0, dm: {}, group: {} };
  USERS[user].friends = USERS[user].friends || [];
  return USERS[user];
}

function defaultSettings() {
  return {
    muteAll: false,
    muteGlobal: true,    // YOU asked default global ping OFF
    muteDM: false,
    muteGroups: false,
    sound: true,
    volume: 0.20,
    reduceMotion: false,
    customCursor: false,
    dmCensor: false,     // optional: client can hide/censor DM words if enabled
  };
}

function addSocketToUser(user, sid) {
  if (!USER_SOCKETS.has(user)) USER_SOCKETS.set(user, new Set());
  USER_SOCKETS.get(user).add(sid);
}

function removeSocketFromUser(user, sid) {
  if (!USER_SOCKETS.has(user)) return;
  USER_SOCKETS.get(user).delete(sid);
  if (USER_SOCKETS.get(user).size === 0) USER_SOCKETS.delete(user);
}

function emitToUser(user, event, payload) {
  const set = USER_SOCKETS.get(user);
  if (!set) return;
  for (const sid of set) io.to(sid).emit(event, payload);
}

function onlineUsersPayload() {
  // Only online users
  const unique = new Set();
  const list = [];
  for (const u of ONLINE.values()) {
    if (unique.has(u)) continue;
    unique.add(u);
    list.push({ user: u });
  }
  list.sort((a, b) => a.user.localeCompare(b.user));
  return list;
}

function broadcastOnline() {
  io.emit("onlineUsers", onlineUsersPayload());
}

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

/* ---------------------- profanity filter (GLOBAL only) ----------------------
   - Blocks N-word + bypass variants
   - Blocks direct death threats / kill threats patterns
   Note: This is a heuristic (still useful for your use-case).
*/
function normalizeForFilter(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")        // zero width
    .replace(/[^a-z0-9\s]/g, " ")                // remove symbols
    .replace(/\s+/g, " ")
    .trim();
}

function containsGlobalBan(text) {
  const raw = String(text || "");
  const t = normalizeForFilter(raw);

  // N-word base + some leetspeak / bypass patterns
  const nwordPatterns = [
    /\bn\s*[i1l!]\s*[gq]\s*[gq]\s*[e3a]\s*r\s*\b/,                 // n i g g e r
    /\bn\s*[i1l!]\s*[gq]\s*[gq]\s*[a4]\s*\b/,                      // n i g g a
    /\bni[gq]{2}er\b/,                                              // niggger-ish
    /\bni[gq]{2}a\b/,
    /\bnigg(er|a|ah|uh|uhh|as|az)\b/,
    /\bniqq(a|er)\b/,
    /\bnegro\b/,                                                   // some users may want this blocked too
  ];

  for (const rx of nwordPatterns) {
    if (rx.test(t)) return { blocked: true, reason: "Blocked word (global chat).", code: "PROFANITY" };
  }

  // Threat patterns (direct)
  const threatPatterns = [
    /\bkill\s+yourself\b/,
    /\bkys\b/,
    /\bi\s*(will|am\s+going\s+to|gonna)\s+kill\s+you\b/,
    /\bim\s*(gonna|going\s+to)\s+kill\s+you\b/,
    /\bgo\s+die\b/,
    /\bhope\s+you\s+die\b/,
    /\bi\s*hope\s+you\s+die\b/,
    /\bdie\s+(in\s+)?(a\s+)?fire\b/,
    /\bshoot\s+you\b/,
    /\bstab\s+you\b/,
  ];

  for (const rx of threatPatterns) {
    if (rx.test(t)) return { blocked: true, reason: "Threats are blocked in global chat.", code: "THREAT" };
  }

  return { blocked: false };
}

/* ---------------------- pings/unreads ---------------------- */
function resetUnread(user, scope, id) {
  const U = ensureUser(user);
  if (!U) return;
  U.unread = U.unread || { global: 0, dm: {}, group: {} };

  if (scope === "global") U.unread.global = 0;
  if (scope === "dm" && id) U.unread.dm[id] = 0;
  if (scope === "group" && id) U.unread.group[id] = 0;

  writeJSON(FILES.users, USERS);
  emitToUser(user, "unread", U.unread);
}

function incUnread(user, scope, id) {
  const U = ensureUser(user);
  if (!U) return;
  U.unread = U.unread || { global: 0, dm: {}, group: {} };

  if (scope === "global") U.unread.global = (U.unread.global || 0) + 1;
  if (scope === "dm" && id) U.unread.dm[id] = (U.unread.dm[id] || 0) + 1;
  if (scope === "group" && id) U.unread.group[id] = (U.unread.group[id] || 0) + 1;

  writeJSON(FILES.users, USERS);
  emitToUser(user, "unread", U.unread);
}

/* ---------------------- socket logic ---------------------- */
io.on("connection", (socket) => {
  socket.data.user = null;
  socket.data.view = { type: "none", id: null }; // used for pings

  // client can ask for history whenever opening global
  socket.on("requestGlobalHistory", () => {
    socket.emit("history", GLOBAL);
  });

  // client tells server what view is active (so we don't ping wrong)
  socket.on("view:set", ({ type, id }) => {
    socket.data.view = { type: type || "none", id: id || null };
    const u = socket.data.user;
    if (!u || isGuest(u)) return;

    // reset unread when they open the view
    if (type === "global") resetUnread(u, "global");
    if (type === "dm" && id) resetUnread(u, "dm", id);
    if (type === "group" && id) resetUnread(u, "group", id);
  });

  // ---- Resume session (auto-login) ----
  socket.on("resume", ({ token }) => {
    const t = norm(token);
    if (!t || !SESSIONS[t]) {
      socket.emit("resumeFail");
      return;
    }
    const u = SESSIONS[t].user;
    if (!u || !USERS[u]) {
      delete SESSIONS[t];
      writeJSON(FILES.sessions, SESSIONS);
      socket.emit("resumeFail");
      return;
    }

    socket.data.user = u;
    ONLINE.set(socket.id, u);
    addSocketToUser(u, socket.id);

    ensureUser(u);

    socket.emit("loginSuccess", {
      username: u,
      guest: false,
      token: t,
      settings: USERS[u].settings,
      unread: USERS[u].unread,
    });

    // send current global history (optional) + online
    socket.emit("history", GLOBAL);
    broadcastOnline();
  });

  // ---- LOGIN ----
  socket.on("login", (payload) => {
    // Accept BOTH formats to avoid mismatches:
    // { username, password, guest } OR { user, pass, guest }
    const guest = !!payload?.guest;

    if (guest) {
      const guestName = `Guest${Math.floor(Math.random() * 9000 + 1000)}`;
      socket.data.user = guestName;
      ONLINE.set(socket.id, guestName);

      socket.emit("loginSuccess", {
        username: guestName,
        guest: true,
        token: null,
        settings: null,
        unread: { global: 0, dm: {}, group: {} },
      });

      socket.emit("history", GLOBAL);
      broadcastOnline();
      return;
    }

    const username = norm(payload?.username ?? payload?.user);
    const password = String(payload?.password ?? payload?.pass ?? "");

    // IMPORTANT: don't allow empty credentials on normal join
    if (!username || !password) {
      socket.emit("loginError", "Missing credentials");
      return;
    }

    // create or validate
    if (!USERS[username]) {
      USERS[username] = {
        passwordHash: hashPass(password),
        createdAt: now(),
        settings: defaultSettings(),
        unread: { global: 0, dm: {}, group: {} },
        friends: [],
      };
      writeJSON(FILES.users, USERS);
    } else {
      ensureUser(username);
      if (USERS[username].passwordHash !== hashPass(password)) {
        socket.emit("loginError", "Wrong password");
        return;
      }
    }

    // make session token
    const token = makeToken();
    SESSIONS[token] = { user: username, createdAt: now() };
    writeJSON(FILES.sessions, SESSIONS);

    socket.data.user = username;
    ONLINE.set(socket.id, username);
    addSocketToUser(username, socket.id);

    socket.emit("loginSuccess", {
      username,
      guest: false,
      token,
      settings: USERS[username].settings,
      unread: USERS[username].unread,
    });

    socket.emit("history", GLOBAL);
    broadcastOnline();
  });

  // ---- SETTINGS ----
  socket.on("settings:update", (settings) => {
    const u = socket.data.user;
    if (!u || isGuest(u) || !USERS[u]) return;

    ensureUser(u);
    USERS[u].settings = { ...USERS[u].settings, ...(settings || {}) };
    writeJSON(FILES.users, USERS);

    emitToUser(u, "settings", USERS[u].settings);
  });

  // ---- GLOBAL MESSAGE ----
  socket.on("sendGlobal", ({ text, ts }) => {
    const u = socket.data.user;
    if (!u) return;

    const msg = String(text || "").trim();
    if (!msg) return;

    // filter invalid timestamps (prevents NaN)
    const time = Number.isFinite(ts) ? ts : now();

    // profanity filter global only
    const check = containsGlobalBan(msg);
    if (check.blocked) {
      socket.emit("sendError", { scope: "global", reason: check.reason, code: check.code });
      return;
    }

    const payload = {
      id: genId(),
      user: u,
      text: msg.slice(0, 900),
      ts: time,
    };

    GLOBAL.push(payload);

    // trim global (keep last 450)
    if (GLOBAL.length > 450) GLOBAL = GLOBAL.slice(GLOBAL.length - 450);

    writeJSON(FILES.global, GLOBAL);

    io.emit("globalMessage", payload);

    // unread logic: everyone except those currently viewing global
    for (const [sid, user] of ONLINE.entries()) {
      if (!user || isGuest(user)) continue;
      if (!USERS[user]) continue;

      const s = io.sockets.sockets.get(sid);
      const view = s?.data?.view;

      const st = USERS[user].settings || defaultSettings();
      const muted = st.muteAll || st.muteGlobal;

      if (!muted && !(view && view.type === "global")) {
        incUnread(user, "global");
      }
    }
  });

  // ---- DM SEND + HISTORY ----
  socket.on("dm:history", ({ withUser }) => {
    const me = socket.data.user;
    const other = norm(withUser);
    if (!me || isGuest(me)) return;
    if (!other || !USERS[other]) return;

    const key = dmKey(me, other);
    const list = Array.isArray(DMS[key]) ? DMS[key] : [];

    socket.emit("dm:history", { withUser: other, msgs: list });
    resetUnread(me, "dm", other);
  });

  socket.on("dm:send", ({ to, text }) => {
    const from = socket.data.user;
    const target = norm(to);
    const msg = String(text || "").trim();

    if (!from || isGuest(from)) {
      socket.emit("sendError", { scope: "dm", reason: "Guests can't DM." });
      return;
    }
    if (!target || !USERS[target]) {
      socket.emit("sendError", { scope: "dm", reason: "User not found." });
      return;
    }
    if (!msg) return;

    const key = dmKey(from, target);
    if (!Array.isArray(DMS[key])) DMS[key] = [];

    const payload = { id: genId(), from, to: target, text: msg.slice(0, 1200), ts: now() };
    DMS[key].push(payload);
    if (DMS[key].length > 500) DMS[key] = DMS[key].slice(DMS[key].length - 500);

    writeJSON(FILES.dms, DMS);

    // deliver to both users
    emitToUser(from, "dm:message", payload);
    emitToUser(target, "dm:message", payload);

    // unread for target if not currently viewing that DM
    const st = ensureUser(target)?.settings || defaultSettings();
    const muted = st.muteAll || st.muteDM;
    if (!muted) {
      const set = USER_SOCKETS.get(target);
      let isViewing = false;
      if (set) {
        for (const sid of set) {
          const s = io.sockets.sockets.get(sid);
          const view = s?.data?.view;
          if (view && view.type === "dm" && view.id === from) isViewing = true;
        }
      }
      if (!isViewing) incUnread(target, "dm", from);
    }
  });

  // ---- GROUPS ----
  socket.on("groups:list", () => {
    const me = socket.data.user;
    if (!me || isGuest(me)) {
      socket.emit("groups:list", []);
      return;
    }

    const list = Object.values(GROUPS)
      .filter((g) => Array.isArray(g.members) && g.members.includes(me))
      .map((g) => ({ id: g.id, name: g.name, owner: g.owner, members: g.members.length }));

    socket.emit("groups:list", list);
  });

  socket.on("group:create", ({ name }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) {
      socket.emit("sendError", { scope: "group", reason: "Guests can't create groups." });
      return;
    }
    const n = norm(name);
    if (!n) {
      socket.emit("sendError", { scope: "group", reason: "Group needs a name." });
      return;
    }

    const gid = "g_" + genId();
    GROUPS[gid] = {
      id: gid,
      name: n.slice(0, 40),
      owner: me,
      members: [me],
      messages: [],
    };
    writeJSON(FILES.groups, GROUPS);

    emitToUser(me, "group:created", GROUPS[gid]);
  });

  socket.on("group:history", ({ groupId }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;
    const gid = norm(groupId);
    const g = GROUPS[gid];
    if (!g || !g.members.includes(me)) return;

    socket.emit("group:history", { groupId: gid, msgs: g.messages || [], meta: { name: g.name, owner: g.owner } });
    resetUnread(me, "group", gid);
  });

  socket.on("group:send", ({ groupId, text }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const gid = norm(groupId);
    const g = GROUPS[gid];
    const msg = String(text || "").trim();

    if (!g || !g.members.includes(me) || !msg) return;

    const payload = { id: genId(), user: me, text: msg.slice(0, 1200), ts: now() };
    g.messages = g.messages || [];
    g.messages.push(payload);
    if (g.messages.length > 700) g.messages = g.messages.slice(g.messages.length - 700);

    writeJSON(FILES.groups, GROUPS);

    // broadcast to all members
    for (const member of g.members) emitToUser(member, "group:message", { groupId: gid, msg: payload });

    // unread increments for members not currently viewing this group
    for (const member of g.members) {
      if (member === me) continue;
      const st = ensureUser(member)?.settings || defaultSettings();
      const muted = st.muteAll || st.muteGroups;
      if (muted) continue;

      const set = USER_SOCKETS.get(member);
      let isViewing = false;
      if (set) {
        for (const sid of set) {
          const s = io.sockets.sockets.get(sid);
          const view = s?.data?.view;
          if (view && view.type === "group" && view.id === gid) isViewing = true;
        }
      }
      if (!isViewing) incUnread(member, "group", gid);
    }
  });

  // ---- GROUP OWNER ONLY: transfer ownership ----
  socket.on("group:transferOwner", ({ groupId, newOwner }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const gid = norm(groupId);
    const to = norm(newOwner);
    const g = GROUPS[gid];

    if (!g) return;
    if (g.owner !== me) {
      socket.emit("sendError", { scope: "group", reason: "Owner only." });
      return;
    }
    if (!to || !g.members.includes(to)) {
      socket.emit("sendError", { scope: "group", reason: "New owner must be a member." });
      return;
    }

    g.owner = to;
    writeJSON(FILES.groups, GROUPS);

    // apply instantly for everyone
    for (const member of g.members) {
      emitToUser(member, "group:meta", { groupId: gid, name: g.name, owner: g.owner });
    }
  });

  // ---- DISCONNECT ----
  socket.on("disconnect", () => {
    const u = ONLINE.get(socket.id);
    ONLINE.delete(socket.id);

    if (u) removeSocketFromUser(u, socket.id);
    broadcastOnline();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ tonkotsu.online listening on ${PORT}`);
});
