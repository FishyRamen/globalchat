/**
 * server.js — tonkotsu.online (Persistent + Settings + Cursor + Reduce Motion + Groups)
 *
 * Folder layout:
 * - server.js
 * - package.json
 * - public/index.html
 * - public/script.js
 * - data/ (auto-created; holds JSON)
 *
 * Render persistence:
 * Add a Render Persistent Disk mounted to: /opt/render/project/src/data
 */

"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");

/* ---------- crash visibility ---------- */
process.on("uncaughtException", (err) => console.error("UNCAUGHT:", err));
process.on("unhandledRejection", (err) => console.error("UNHANDLED:", err));

/* ---------- helpers ---------- */
const now = () => Date.now();
const genId = () => Math.random().toString(36).slice(2) + "-" + now().toString(36);
const norm = (s) => String(s || "").trim();
const isGuest = (u) => /^Guest\d{1,10}$/.test(String(u || ""));

// simple hash (hobby). Use bcrypt for real production.
function hashPass(p) {
  const s = String(p || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function safeJSONParse(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

/* ---------- persistent storage ---------- */
const DATA_DIR = path.join(__dirname, "data"); // IMPORTANT: mount disk here on Render
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  users: path.join(DATA_DIR, "users.json"),
  global: path.join(DATA_DIR, "global.json"),
  dms: path.join(DATA_DIR, "dms.json"),
  groups: path.join(DATA_DIR, "groups.json"),
  social: path.join(DATA_DIR, "social.json"),
};

function ensureFile(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf8");
  }
}

function readFile(filePath, fallback) {
  ensureFile(filePath, fallback);
  const raw = fs.readFileSync(filePath, "utf8");
  return safeJSONParse(raw || "", fallback);
}

// atomic write (prevents partial corruption)
function writeFileAtomic(filePath, value) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, filePath);
}

// defaults
ensureFile(FILES.users, {});
ensureFile(FILES.global, []);
ensureFile(FILES.dms, {});
ensureFile(FILES.groups, {});
ensureFile(FILES.social, {});

/* ---------- load state ---------- */
let USERS = readFile(FILES.users, {});
let GLOBAL = readFile(FILES.global, []);
let DMS = readFile(FILES.dms, {});
let GROUPS = readFile(FILES.groups, {});
let SOCIAL = readFile(FILES.social, {});

function colorForUser(u) {
  const base = hashPass(u).padStart(6, "0").slice(0, 6);
  let r = parseInt(base.slice(0, 2), 16);
  let g = parseInt(base.slice(2, 4), 16);
  let b = parseInt(base.slice(4, 6), 16);
  r = Math.min(255, Math.floor((r + 255) / 2));
  g = Math.min(255, Math.floor((g + 255) / 2));
  b = Math.min(255, Math.floor((b + 255) / 2));
  return `rgb(${r},${g},${b})`;
}

function ensureSocial(u) {
  if (!SOCIAL[u]) SOCIAL[u] = { friends: [], incoming: [], outgoing: [] };
  return SOCIAL[u];
}

const DEFAULT_SETTINGS = {
  // audio/pings
  volume: 0.22,
  // UI
  reduceMotion: false,
  customCursor: true,
  cursorTrail: true,
  showTimestamps: true,
};

const DEFAULT_MUTES = {
  muteAll: false,
  global: true, // IMPORTANT: global ping default OFF
  dm: {},
  group: {},
};

function ensureUser(u) {
  if (!USERS[u]) return null;
  USERS[u].settings = { ...DEFAULT_SETTINGS, ...(USERS[u].settings || {}) };
  USERS[u].mutes = { ...DEFAULT_MUTES, ...(USERS[u].mutes || {}) };
  USERS[u].createdAt = USERS[u].createdAt || now();
  USERS[u].color = USERS[u].color || colorForUser(u);
  return USERS[u];
}

/* ---------- hygiene: remove invalid timestamps ---------- */
GLOBAL = (GLOBAL || []).filter(m => m && typeof m.ts === "number" && isFinite(m.ts) && m.ts > 0);
writeFileAtomic(FILES.global, GLOBAL);

for (const k of Object.keys(DMS || {})) {
  DMS[k] = (DMS[k] || []).filter(m => m && typeof m.ts === "number" && isFinite(m.ts) && m.ts > 0);
}
writeFileAtomic(FILES.dms, DMS);

for (const gid of Object.keys(GROUPS || {})) {
  const g = GROUPS[gid];
  if (!g) continue;
  g.messages = Array.isArray(g.messages) ? g.messages : [];
  g.messages = g.messages.filter(m => m && typeof m.ts === "number" && isFinite(m.ts) && m.ts > 0);
}
writeFileAtomic(FILES.groups, GROUPS);

function dmKey(a, b) {
  const x = String(a), y = String(b);
  return x < y ? `${x}__${y}` : `${y}__${x}`;
}

/* ---------- live session tracking ---------- */
const ONLINE = new Map();       // socket.id -> username
const USER_SOCKETS = new Map(); // username -> Set(socket.id)

function addSocketUser(u, sid) {
  ONLINE.set(sid, u);
  if (!USER_SOCKETS.has(u)) USER_SOCKETS.set(u, new Set());
  USER_SOCKETS.get(u).add(sid);
}
function removeSocketUser(sid) {
  const u = ONLINE.get(sid);
  ONLINE.delete(sid);
  if (u && USER_SOCKETS.has(u)) {
    USER_SOCKETS.get(u).delete(sid);
    if (USER_SOCKETS.get(u).size === 0) USER_SOCKETS.delete(u);
  }
}
function pushToUser(u, event, payload) {
  const set = USER_SOCKETS.get(u);
  if (!set) return;
  for (const sid of set) io.to(sid).emit(event, payload);
}
function onlinePayload() {
  const seen = new Set();
  const out = [];
  for (const [, u] of ONLINE) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push({
      user: u,
      color: USERS[u]?.color || colorForUser(u),
      guest: isGuest(u),
    });
  }
  out.sort((a, b) => a.user.localeCompare(b.user));
  return out;
}
function emitOnline() {
  io.emit("onlineUsers", onlinePayload());
}

function buildState(u) {
  const user = ensureUser(u);
  const social = ensureSocial(u);

  const groups = [];
  for (const gid of Object.keys(GROUPS)) {
    const g = GROUPS[gid];
    if (g && Array.isArray(g.members) && g.members.includes(u)) {
      groups.push({ id: g.id, name: g.name, owner: g.owner, members: g.members });
    }
  }

  const conversations = [];
  (social.friends || []).forEach((f) => conversations.push({ kind: "dm", id: f, name: f }));
  groups.forEach((g) => conversations.push({ kind: "group", id: g.id, name: g.name }));

  const inbox = [];
  (social.incoming || []).forEach((from) => inbox.push({ type: "friend_request", id: "fr_" + from, from }));

  for (const gid of Object.keys(GROUPS)) {
    const g = GROUPS[gid];
    if (g && g.invites && g.invites[u]) {
      inbox.push({
        type: "group_invite",
        id: "gi_" + gid,
        groupId: gid,
        from: g.invites[u].from,
        name: g.name,
      });
    }
  }

  return {
    me: { user: u, color: user.color },
    settings: user.settings,
    mutes: user.mutes,
    friends: social.friends || [],
    incoming: social.incoming || [],
    outgoing: social.outgoing || [],
    groups,
    conversations,
    inbox,
  };
}

/* ---------- server ---------- */
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  maxHttpBufferSize: 1e6,
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ---------- sockets ---------- */
io.on("connection", (socket) => {
  socket.data.user = null;

  socket.on("login", ({ user, pass }) => {
    try {
      let u = norm(user);
      const p = String(pass || "");
      const wantsGuest = (!u && !p);

      // require both if not guest
      if (!wantsGuest && ((u && !p) || (!u && p))) {
        socket.emit("loginError", "Username and password must be used together (or leave both blank for Guest).");
        return;
      }

      if (wantsGuest) u = "Guest" + Math.floor(Math.random() * 100000);

      if (u.length < 1 || u.length > 20) {
        socket.emit("loginError", "Username must be 1–20 characters.");
        return;
      }

      const guest = wantsGuest || isGuest(u);

      if (!guest) {
        if (!USERS[u]) {
          USERS[u] = {
            passHash: hashPass(p),
            createdAt: now(),
            color: colorForUser(u),
            settings: { ...DEFAULT_SETTINGS },
            mutes: { ...DEFAULT_MUTES },
          };
          ensureSocial(u);
          writeFileAtomic(FILES.users, USERS);
          writeFileAtomic(FILES.social, SOCIAL);
        } else {
          ensureUser(u);
          if (USERS[u].passHash !== hashPass(p)) {
            socket.emit("loginError", "Wrong password for that username.");
            return;
          }
          ensureSocial(u);
          writeFileAtomic(FILES.users, USERS);
          writeFileAtomic(FILES.social, SOCIAL);
        }
      }

      socket.data.user = u;
      addSocketUser(u, socket.id);

      socket.emit("loginSuccess", {
        user: u,
        color: guest ? colorForUser(u) : USERS[u].color,
        guest,
      });

      socket.emit("history", GLOBAL);

      if (!guest) socket.emit("state", buildState(u));
      else socket.emit("state", { me: { user: u, color: colorForUser(u) }, guest: true });

      emitOnline();
    } catch (e) {
      console.error("login error:", e);
      socket.emit("loginError", "Login failed.");
    }
  });

  /* global chat */
  socket.on("chat", ({ text }) => {
    const u = socket.data.user;
    if (!u) return;

    const msg = String(text || "").trim();
    if (!msg) return;

    const payload = {
      id: genId(),
      user: u,
      text: msg.slice(0, 1400),
      ts: now(),
      color: (USERS[u]?.color || colorForUser(u)),
    };

    GLOBAL.push(payload);
    if (GLOBAL.length > 700) GLOBAL = GLOBAL.slice(-700);
    writeFileAtomic(FILES.global, GLOBAL);

    io.emit("chat", payload);
  });

  /* settings */
  socket.on("updateSettings", (s) => {
    const u = socket.data.user;
    if (!u || isGuest(u)) return;
    ensureUser(u);

    USERS[u].settings = { ...USERS[u].settings, ...(s || {}) };
    writeFileAtomic(FILES.users, USERS);

    // sync all tabs
    pushToUser(u, "state", buildState(u));
  });

  socket.on("updateMutes", (m) => {
    const u = socket.data.user;
    if (!u || isGuest(u)) return;
    ensureUser(u);

    const cur = USERS[u].mutes || { ...DEFAULT_MUTES };
    USERS[u].mutes = {
      muteAll: !!m?.muteAll,
      global: !!m?.global,
      dm: { ...(cur.dm || {}), ...(m?.dm || {}) },
      group: { ...(cur.group || {}), ...(m?.group || {}) },
    };
    writeFileAtomic(FILES.users, USERS);

    pushToUser(u, "state", buildState(u));
  });

  /* friend requests */
  socket.on("sendFriendRequest", ({ user: target }) => {
    const from = socket.data.user;
    if (!from || isGuest(from)) return;

    const to = norm(target);
    if (!to || to === from) return;
    if (!USERS[to]) {
      socket.emit("actionError", { scope: "friends", msg: "That user doesn’t exist." });
      return;
    }

    const sf = ensureSocial(from);
    const st = ensureSocial(to);

    if ((sf.friends || []).includes(to)) {
      socket.emit("actionError", { scope: "friends", msg: "Already friends." });
      return;
    }

    if (!(sf.outgoing || []).includes(to)) sf.outgoing.push(to);
    if (!(st.incoming || []).includes(from)) st.incoming.push(from);

    writeFileAtomic(FILES.social, SOCIAL);

    pushToUser(from, "state", buildState(from));
    pushToUser(to, "state", buildState(to));
    pushToUser(from, "friendRequestSent", { to });
  });

  socket.on("acceptFriendRequest", ({ from }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const other = norm(from);
    if (!other || !USERS[other]) return;

    const sm = ensureSocial(me);
    const so = ensureSocial(other);

    sm.incoming = (sm.incoming || []).filter((x) => x !== other);
    so.outgoing = (so.outgoing || []).filter((x) => x !== me);

    if (!(sm.friends || []).includes(other)) sm.friends.push(other);
    if (!(so.friends || []).includes(me)) so.friends.push(me);

    writeFileAtomic(FILES.social, SOCIAL);

    pushToUser(me, "state", buildState(me));
    pushToUser(other, "state", buildState(other));
    pushToUser(me, "friendAccepted", { user: other });
    pushToUser(other, "friendAccepted", { user: me });
  });

  socket.on("declineFriendRequest", ({ from }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const other = norm(from);
    if (!other || !USERS[other]) return;

    const sm = ensureSocial(me);
    const so = ensureSocial(other);

    sm.incoming = (sm.incoming || []).filter((x) => x !== other);
    so.outgoing = (so.outgoing || []).filter((x) => x !== me);

    writeFileAtomic(FILES.social, SOCIAL);

    pushToUser(me, "state", buildState(me));
    pushToUser(other, "state", buildState(other));
    pushToUser(me, "friendDeclined", { user: other });
  });

  socket.on("getInbox", () => {
    const u = socket.data.user;
    if (!u || isGuest(u)) return;
    socket.emit("inbox", buildState(u).inbox || []);
  });

  /* DMs (friends only) */
  socket.on("openDM", ({ withUser }) => {
    const me = socket.data.user;
    if (!me) return;
    if (isGuest(me)) return socket.emit("dmError", "Guests can’t use DMs.");

    const other = norm(withUser);
    if (!other || !USERS[other]) return socket.emit("dmError", "User not found.");

    const key = dmKey(me, other);
    const msgs = Array.isArray(DMS[key]) ? DMS[key] : [];

    socket.emit("dmHistory", {
      withUser: other,
      msgs,
      colors: {
        [me]: USERS[me]?.color || colorForUser(me),
        [other]: USERS[other]?.color || colorForUser(other),
      },
    });
  });

  socket.on("sendDM", ({ to, text }) => {
    const from = socket.data.user;
    if (!from) return;
    if (isGuest(from)) return socket.emit("dmError", "Guests can’t use DMs.");

    const target = norm(to);
    if (!target || !USERS[target] || target === from) return socket.emit("dmError", "Invalid DM target.");

    // only friends
    const sf = ensureSocial(from);
    if (!(sf.friends || []).includes(target)) return socket.emit("dmError", "You must be friends to DM.");

    const msg = String(text || "").trim();
    if (!msg) return;

    const key = dmKey(from, target);
    if (!Array.isArray(DMS[key])) DMS[key] = [];

    const payload = { id: genId(), from, to: target, text: msg.slice(0, 1800), ts: now() };
    DMS[key].push(payload);
    if (DMS[key].length > 700) DMS[key] = DMS[key].slice(-700);
    writeFileAtomic(FILES.dms, DMS);

    const colors = {
      [from]: USERS[from]?.color || colorForUser(from),
      [target]: USERS[target]?.color || colorForUser(target),
    };

    pushToUser(from, "dm", { ...payload, colors });
    pushToUser(target, "dm", { ...payload, colors });
  });

  /* Groups */
  socket.on("createGroup", ({ name, members }) => {
    const owner = socket.data.user;
    if (!owner || isGuest(owner)) return;

    const soc = ensureSocial(owner);
    const list = Array.isArray(members) ? members.map(norm).filter(Boolean) : [];
    const allowed = list.filter((u) => (soc.friends || []).includes(u) && USERS[u]);

    if (allowed.length === 0) return socket.emit("groupError", "Pick at least one friend.");

    const gid = genId();
    const gname = (String(name || "").trim() || "Group chat").slice(0, 40);

    GROUPS[gid] = {
      id: gid,
      name: gname,
      owner,
      members: [owner],
      invites: {},
      createdAt: now(),
      messages: [],
    };

    allowed.forEach((u) => (GROUPS[gid].invites[u] = { from: owner, ts: now() }));
    writeFileAtomic(FILES.groups, GROUPS);

    pushToUser(owner, "state", buildState(owner));
    allowed.forEach((u) => pushToUser(u, "state", buildState(u)));
    socket.emit("groupCreated", { groupId: gid });
  });

  socket.on("acceptGroupInvite", ({ groupId }) => {
    const u = socket.data.user;
    if (!u || isGuest(u)) return;

    const gid = norm(groupId);
    const g = GROUPS[gid];
    if (!g || !g.invites || !g.invites[u]) return;

    delete g.invites[u];
    if (!g.members.includes(u)) g.members.push(u);
    writeFileAtomic(FILES.groups, GROUPS);

    g.members.forEach((m) => pushToUser(m, "state", buildState(m)));
  });

  socket.on("declineGroupInvite", ({ groupId }) => {
    const u = socket.data.user;
    if (!u || isGuest(u)) return;

    const gid = norm(groupId);
    const g = GROUPS[gid];
    if (!g || !g.invites || !g.invites[u]) return;

    delete g.invites[u];
    writeFileAtomic(FILES.groups, GROUPS);
    pushToUser(u, "state", buildState(u));
  });

  socket.on("openGroup", ({ groupId }) => {
    const u = socket.data.user;
    if (!u || isGuest(u)) return socket.emit("groupError", "Guests can’t use groups.");

    const gid = norm(groupId);
    const g = GROUPS[gid];
    if (!g || !Array.isArray(g.members) || !g.members.includes(u)) return socket.emit("groupError", "You’re not in that group.");

    const colors = Object.fromEntries((g.members || []).map(m => [m, USERS[m]?.color || colorForUser(m)]));

    socket.emit("groupHistory", {
      group: { id: g.id, name: g.name, owner: g.owner, members: g.members },
      msgs: g.messages || [],
      colors
    });
  });

  socket.on("sendGroup", ({ groupId, text }) => {
    const from = socket.data.user;
    if (!from || isGuest(from)) return;

    const gid = norm(groupId);
    const g = GROUPS[gid];
    if (!g || !Array.isArray(g.members) || !g.members.includes(from)) return;

    const msg = String(text || "").trim();
    if (!msg) return;

    const payload = { id: genId(), groupId: g.id, from, text: msg.slice(0, 1800), ts: now() };
    g.messages.push(payload);
    if (g.messages.length > 900) g.messages = g.messages.slice(-900);
    writeFileAtomic(FILES.groups, GROUPS);

    const colors = Object.fromEntries((g.members || []).map(m => [m, USERS[m]?.color || colorForUser(m)]));
    g.members.forEach((m) => pushToUser(m, "groupMsg", { ...payload, colors }));
  });

  // Owner-only group management
  socket.on("groupManage", ({ groupId, action, user, name }) => {
    const me = socket.data.user;
    if (!me || isGuest(me)) return;

    const gid = norm(groupId);
    const g = GROUPS[gid];
    if (!g) return;

    if (g.owner !== me) return socket.emit("groupError", "Only the owner can manage this group.");

    const act = String(action || "");

    if (act === "rename") {
      const newName = String(name || "").trim();
      if (!newName) return;
      g.name = newName.slice(0, 40);
    }

    if (act === "invite") {
      const target = norm(user);
      if (!target || !USERS[target]) return;
      const soc = ensureSocial(me);
      if (!(soc.friends || []).includes(target)) return;
      if (g.members.includes(target)) return;
      g.invites = g.invites || {};
      g.invites[target] = { from: me, ts: now() };
      pushToUser(target, "state", buildState(target));
    }

    if (act === "remove") {
      const target = norm(user);
      if (!target) return;
      if (target === g.owner) return;
      g.members = (g.members || []).filter(m => m !== target);
      if (g.invites) delete g.invites[target];
      pushToUser(target, "state", buildState(target));
    }

    if (act === "transferOwner") {
      const target = norm(user);
      if (!target) return;
      if (!g.members.includes(target)) return;
      g.owner = target;
    }

    if (act === "delete") {
      const members = g.members || [];
      delete GROUPS[gid];
      writeFileAtomic(FILES.groups, GROUPS);
      members.forEach(m => pushToUser(m, "state", buildState(m)));
      return;
    }

    writeFileAtomic(FILES.groups, GROUPS);

    // apply instantly
    (g.members || []).forEach(m => pushToUser(m, "state", buildState(m)));
    (g.members || []).forEach(m => pushToUser(m, "groupMeta", { id: g.id, name: g.name, owner: g.owner, members: g.members }));
  });

  socket.on("disconnect", () => {
    removeSocketUser(socket.id);
    emitOnline();
  });
});

/* ---------- listen (ONLY ONCE) ---------- */
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server listening on ${PORT}`);
});
