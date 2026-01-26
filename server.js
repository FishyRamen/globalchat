// server.js (CommonJS)
// Tonkotsu.online baseline server for script.js client
require("dotenv").config();

const path = require("path");
const express = require("express");
const http = require("http");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { nanoid } = require("nanoid");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev_jwt_secret_change_me";
const ADMIN_SHARED_SECRET = process.env.ADMIN_SHARED_SECRET || "dev_admin_secret_change_me";

// -------------------------
// In-memory data (DEV ONLY)
// -------------------------
const db = {
  usersById: new Map(),       // id -> user
  usersByUsername: new Map(), // usernameLower -> user
  sessions: new Map(),        // token -> { userId, createdAt }
  friends: new Map(),         // userId -> Set(friendUserId)
  groups: new Map(),          // groupId -> group
  groupMembers: new Map(),    // groupId -> Set(userId)
  messages: {
    global: [],               // {id, ts, text, user:{id,username,color}, editedAt?, kind?}
    dm: new Map(),            // key "a|b" -> []
    group: new Map()          // groupId -> []
  },
  idempotency: new Map(),     // key `${userId}:${clientId}` -> messageId
  reports: [],                // queued reports for bot
  bans: {
    user: new Map(),          // usernameLower -> { until, strikes, permanent }
    ip: new Map()             // ip -> { until, strikes, permanent }
  }
};

// Seed an owner/admin user (change after first boot)
seedAdminUser();

// -------------------------
// Express + HTTP + Socket.IO
// -------------------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  transports: ["websocket", "polling"]
});

// Basic security headers
app.use(helmet({
  contentSecurityPolicy: false // if you serve inline scripts/styles, keep off; tighten later
}));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// Rate limit (adjust)
app.use(rateLimit({
  windowMs: 60_000,
  limit: 240
}));

// Serve public/
app.use(express.static(path.join(__dirname, "public")));

// -------------------------
// Helpers
// -------------------------
function now() { return Date.now(); }
function lower(s) { return String(s || "").trim().toLowerCase(); }
function safeStr(s, max = 5000) { return String(s ?? "").slice(0, max); }

function pickColor(seed) {
  // deterministic-ish color from username
  const s = lower(seed);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const palette = [
    "#9aa3b7","#ff5c7a","#7cffc6","#ffd278","#8fb8ff","#d18fff","#7df0ff","#ff9c5c",
    "#b6ff8f","#ff7df0","#c2c8ff","#9cffc2"
  ];
  return palette[h % palette.length];
}

function signToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "14d" });
}

function verifyToken(token) {
  const p = jwt.verify(token, JWT_SECRET);
  return p?.sub || null;
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });
  try {
    const userId = verifyToken(token);
    const user = db.usersById.get(userId);
    if (!user) return res.status(401).json({ ok: false, error: "Unauthorized" });

    // ban checks (user + ip)
    const ip = getIp(req);
    const banU = db.bans.user.get(lower(user.username));
    if (banU && banU.permanent) return res.status(403).json({ ok: false, error: "This account has been erased." });
    if (banU && banU.until && now() < banU.until) return res.status(403).json({ ok: false, error: "This account is temporarily disabled." });

    const banIp = db.bans.ip.get(ip);
    if (banIp && banIp.permanent) return res.status(403).json({ ok: false, error: "Access blocked." });
    if (banIp && banIp.until && now() < banIp.until) return res.status(403).json({ ok: false, error: "Access temporarily blocked." });

    req.user = user;
    req.token = token;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

function getIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function userPublic(u) {
  return {
    id: u.id,
    username: u.username,
    color: u.color,
    badges: u.badges || [],
    createdAt: u.createdAt || null,
    lastSeen: u.lastSeen || null,
    bio: u.bio || ""
  };
}

function dmKey(a, b) {
  const A = String(a), B = String(b);
  return A < B ? `${A}|${B}` : `${B}|${A}`;
}

function pushMessage(list, msg, limit = 500) {
  list.push(msg);
  if (list.length > limit) list.splice(0, list.length - limit);
}

function canEditOrDelete(message, user) {
  const mine = message?.user?.id && user?.id && message.user.id === user.id;
  const age = now() - (message.ts || 0);
  return mine && age <= 60_000;
}

// -------------------------
// Auth endpoints
// -------------------------
app.post("/api/auth/login", (req, res) => {
  const username = safeStr(req.body?.username, 64);
  const password = safeStr(req.body?.password, 256);
  const u = db.usersByUsername.get(lower(username));
  if (!u) return res.status(400).json({ ok: false, error: "Invalid credentials" });

  // ban checks
  const banU = db.bans.user.get(lower(u.username));
  if (banU?.permanent) return res.status(403).json({ ok: false, error: "This account has been erased." });
  if (banU?.until && now() < banU.until) return res.status(403).json({ ok: false, error: "This account is temporarily disabled." });

  const ok = bcrypt.compareSync(password, u.passHash);
  if (!ok) return res.status(400).json({ ok: false, error: "Invalid credentials" });

  const token = signToken(u);
  db.sessions.set(token, { userId: u.id, createdAt: now() });
  return res.json({ ok: true, token, user: userPublic(u) });
});

app.post("/api/auth/guest", (req, res) => {
  // guest accounts: create ephemeral user
  const id = nanoid(10);
  const username = `guest${Math.floor(Math.random() * 9000 + 1000)}`;
  const u = {
    id,
    username,
    color: pickColor(username),
    badges: ["Guest"],
    createdAt: now(),
    lastSeen: now(),
    bio: ""
  };
  db.usersById.set(id, u);
  db.usersByUsername.set(lower(username), u);
  db.friends.set(id, new Set());

  const token = signToken(u);
  db.sessions.set(token, { userId: u.id, createdAt: now() });

  return res.json({ ok: true, token, user: userPublic(u) });
});

app.post("/api/auth/logout", authMiddleware, (req, res) => {
  if (req.token) db.sessions.delete(req.token);
  return res.json({ ok: true });
});

app.get("/api/users/me", authMiddleware, (req, res) => {
  req.user.lastSeen = now();
  return res.json({ ok: true, user: userPublic(req.user) });
});

// -------------------------
// Bootstrap state
// -------------------------
app.get("/api/state/bootstrap", authMiddleware, (req, res) => {
  const me = req.user;
  me.lastSeen = now();

  const friendsSet = db.friends.get(me.id) || new Set();
  const friends = Array.from(friendsSet).map((fid) => {
    const fu = db.usersById.get(fid);
    return fu ? userPublic(fu) : null;
  }).filter(Boolean);

  const groups = Array.from(db.groups.values())
    .filter(g => (db.groupMembers.get(g.id) || new Set()).has(me.id))
    .map(g => ({
      id: g.id,
      name: g.name,
      ownerId: g.ownerId,
      limit: g.limit,
      cooldownSeconds: g.cooldownSeconds
    }));

  // optional: include online user list (unique users, not sockets)
  const onlineUsers = getOnlineUsersList();

  // global feed
  const global = {
    messages: db.messages.global.slice(-80),
    cursor: db.messages.global.length ? db.messages.global[0].id : null,
    hasMore: db.messages.global.length > 80
  };

  return res.json({
    ok: true,
    global,
    friends,
    groups,
    onlineUsers
  });
});

// -------------------------
// Messages read
// -------------------------
app.get("/api/messages/global", authMiddleware, (req, res) => {
  const limit = clampInt(req.query.limit, 80, 1, 200);
  const before = safeStr(req.query.before || "", 64);

  let list = db.messages.global.slice();
  if (before) {
    const idx = list.findIndex(m => m.id === before);
    if (idx > 0) list = list.slice(0, idx);
  }
  const out = list.slice(-limit);
  return res.json({
    ok: true,
    messages: out,
    cursor: out.length ? out[0].id : null,
    hasMore: list.length > out.length
  });
});

app.get("/api/messages/dm/:peerId", authMiddleware, (req, res) => {
  const me = req.user;
  const peerId = safeStr(req.params.peerId, 64);
  const peer = db.usersById.get(peerId);
  if (!peer) return res.status(404).json({ ok: false, error: "User not found" });

  const key = dmKey(me.id, peerId);
  const list = db.messages.dm.get(key) || [];
  const limit = clampInt(req.query.limit, 80, 1, 200);
  const before = safeStr(req.query.before || "", 64);

  let slice = list.slice();
  if (before) {
    const idx = slice.findIndex(m => m.id === before);
    if (idx > 0) slice = slice.slice(0, idx);
  }
  const out = slice.slice(-limit);

  return res.json({
    ok: true,
    peer: userPublic(peer),
    messages: out,
    cursor: out.length ? out[0].id : null,
    hasMore: slice.length > out.length
  });
});

app.get("/api/messages/group/:groupId", authMiddleware, (req, res) => {
  const me = req.user;
  const gid = safeStr(req.params.groupId, 64);
  const g = db.groups.get(gid);
  if (!g) return res.status(404).json({ ok: false, error: "Group not found" });

  const members = db.groupMembers.get(gid) || new Set();
  if (!members.has(me.id)) return res.status(403).json({ ok: false, error: "Not a member" });

  const list = db.messages.group.get(gid) || [];
  const limit = clampInt(req.query.limit, 90, 1, 200);
  const before = safeStr(req.query.before || "", 64);

  let slice = list.slice();
  if (before) {
    const idx = slice.findIndex(m => m.id === before);
    if (idx > 0) slice = slice.slice(0, idx);
  }
  const out = slice.slice(-limit);

  return res.json({
    ok: true,
    group: { id: g.id, name: g.name, ownerId: g.ownerId, limit: g.limit, cooldownSeconds: g.cooldownSeconds },
    messages: out,
    cursor: out.length ? out[0].id : null,
    hasMore: slice.length > out.length
  });
});

// -------------------------
// Send/edit/delete/report
// -------------------------
app.post("/api/messages/send", authMiddleware, (req, res) => {
  const me = req.user;
  const scope = safeStr(req.body?.scope, 16);
  const targetId = safeStr(req.body?.targetId || "", 64) || null;
  const text = safeStr(req.body?.text, 4000).trim();
  const clientId = safeStr(req.body?.clientId || "", 96);

  if (!text) return res.status(400).json({ ok: false, error: "Empty message" });

  // idempotency: if client retries, return same message
  if (clientId) {
    const key = `${me.id}:${clientId}`;
    const existingId = db.idempotency.get(key);
    if (existingId) {
      // find and return message
      const msg = findMessageById(scope, targetId, existingId);
      if (msg) return res.json({ ok: true, message: msg });
    }
  }

  // cooldown (example): 2s for global, 1s elsewhere; groups can override
  const cdMs = computeCooldownMs(me, scope, targetId);
  if (me.cooldownUntil && now() < me.cooldownUntil) {
    return res.status(429).json({ ok: false, error: "Cooldown", cooldownUntil: me.cooldownUntil, cooldownMs: cdMs });
  }
  me.cooldownUntil = now() + cdMs;

  const msg = {
    id: nanoid(12),
    ts: now(),
    text,
    scope,
    targetId,
    user: { id: me.id, username: me.username, color: me.color },
    clientId: clientId || null
  };

  if (scope === "global") {
    pushMessage(db.messages.global, msg, 800);
    io.emit("message:new", msg);
  } else if (scope === "dm") {
    if (!targetId) return res.status(400).json({ ok: false, error: "Missing targetId" });
    const peer = db.usersById.get(targetId);
    if (!peer) return res.status(404).json({ ok: false, error: "User not found" });

    const key = dmKey(me.id, targetId);
    const list = db.messages.dm.get(key) || [];
    pushMessage(list, msg, 500);
    db.messages.dm.set(key, list);

    // emit only to DM participants
    emitToUsers([me.id, targetId], "message:new", msg);
  } else if (scope === "group") {
    if (!targetId) return res.status(400).json({ ok: false, error: "Missing groupId" });
    const gid = targetId;
    const g = db.groups.get(gid);
    if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
    const members = db.groupMembers.get(gid) || new Set();
    if (!members.has(me.id)) return res.status(403).json({ ok: false, error: "Not a member" });

    const list = db.messages.group.get(gid) || [];
    pushMessage(list, msg, 800);
    db.messages.group.set(gid, list);

    emitToGroup(gid, "message:new", msg);
  } else {
    return res.status(400).json({ ok: false, error: "Bad scope" });
  }

  // store idempotency mapping
  if (clientId) db.idempotency.set(`${me.id}:${clientId}`, msg.id);

  return res.json({ ok: true, message: msg, cooldownUntil: me.cooldownUntil, cooldownMs: cdMs });
});

app.post("/api/messages/edit", authMiddleware, (req, res) => {
  const me = req.user;
  const messageId = safeStr(req.body?.messageId, 64);
  const text = safeStr(req.body?.text, 4000).trim();
  const scope = safeStr(req.body?.scope, 16);
  const targetId = safeStr(req.body?.targetId || "", 64) || null;

  if (!messageId || !text) return res.status(400).json({ ok: false, error: "Bad request" });

  const msg = findMessageById(scope, targetId, messageId);
  if (!msg) return res.status(404).json({ ok: false, error: "Not found" });

  if (!canEditOrDelete(msg, me)) return res.status(403).json({ ok: false, error: "Edit window expired" });

  msg.text = text;
  msg.editedAt = now();

  emitEdit(scope, targetId, msg);
  return res.json({ ok: true, message: msg });
});

app.post("/api/messages/delete", authMiddleware, (req, res) => {
  const me = req.user;
  const messageId = safeStr(req.body?.messageId, 64);
  const scope = safeStr(req.body?.scope, 16);
  const targetId = safeStr(req.body?.targetId || "", 64) || null;

  const ok = deleteMessageById(scope, targetId, messageId, me);
  if (!ok) return res.status(400).json({ ok: false, error: "Delete failed" });

  emitDelete(scope, targetId, messageId);
  return res.json({ ok: true });
});

app.post("/api/messages/report", authMiddleware, (req, res) => {
  const me = req.user;
  const messageId = safeStr(req.body?.messageId, 64);
  const reason = safeStr(req.body?.reason || "", 400);

  // store report with enough context for bot
  const rpt = {
    id: nanoid(10),
    ts: now(),
    reporter: { id: me.id, username: me.username },
    messageId,
    reason
  };
  db.reports.push(rpt);
  pushMessage(db.reports, rpt, 2000);

  // Optional: also emit to admin sockets if you want a built-in admin panel later
  emitToAdmins("report:new", rpt);

  return res.json({ ok: true });
});

// -------------------------
// Friends + Groups
// -------------------------
app.post("/api/friends/request", authMiddleware, (req, res) => {
  const me = req.user;
  const username = safeStr(req.body?.username, 64);
  const u = db.usersByUsername.get(lower(username));
  if (!u) return res.status(404).json({ ok: false, error: "User not found" });
  if (u.id === me.id) return res.status(400).json({ ok: false, error: "Cannot friend yourself" });

  // simple: auto-accept for now (you can add requests later)
  if (!db.friends.has(me.id)) db.friends.set(me.id, new Set());
  if (!db.friends.has(u.id)) db.friends.set(u.id, new Set());
  db.friends.get(me.id).add(u.id);
  db.friends.get(u.id).add(me.id);

  return res.json({ ok: true });
});

app.post("/api/groups/create", authMiddleware, (req, res) => {
  const me = req.user;
  const name = safeStr(req.body?.name, 48).trim() || "Group Chat";
  const limit = clampInt(req.body?.limit ?? 25, 25, 2, 200);
  const cooldownSeconds = clampInt(req.body?.cooldownSeconds ?? 2, 2, 0, 30);

  const gid = nanoid(10);
  const g = {
    id: gid,
    name,
    ownerId: me.id,
    limit,
    cooldownSeconds,
    createdAt: now()
  };
  db.groups.set(gid, g);
  db.groupMembers.set(gid, new Set([me.id]));
  db.messages.group.set(gid, []);

  return res.json({ ok: true, group: g });
});

// -------------------------
// Bot integration endpoints
// (server-to-bot via polling OR bot-to-server via secret)
// -------------------------

// Bot polls reports
app.get("/api/bot/reports", (req, res) => {
  if (!isBot(req)) return res.status(403).json({ ok: false, error: "Forbidden" });
  const limit = clampInt(req.query.limit ?? 20, 20, 1, 100);
  const out = db.reports.slice(-limit);
  return res.json({ ok: true, reports: out });
});

// Bot deletes a user (and applies progressive ban policy)
app.post("/api/bot/deleteUser", (req, res) => {
  if (!isBot(req)) return res.status(403).json({ ok: false, error: "Forbidden" });
  const username = safeStr(req.body?.username, 64);
  const u = db.usersByUsername.get(lower(username));
  if (!u) return res.status(404).json({ ok: false, error: "User not found" });

  // progressive bans: 3d -> 7d -> 365d -> permanent
  const key = lower(u.username);
  const prev = db.bans.user.get(key) || { strikes: 0, until: 0, permanent: false };
  const strikes = (prev.strikes || 0) + 1;

  let until = 0;
  let permanent = false;

  if (strikes === 1) until = now() + 3 * 24 * 60 * 60 * 1000;
  else if (strikes === 2) until = now() + 7 * 24 * 60 * 60 * 1000;
  else if (strikes === 3) until = now() + 365 * 24 * 60 * 60 * 1000;
  else permanent = true;

  db.bans.user.set(key, { strikes, until, permanent });

  // “erase” account: remove from maps and disconnect sockets
  eraseUser(u.id);

  return res.json({ ok: true, strikes, until, permanent });
});

// Bot IP timeout/ban
app.post("/api/bot/banIp", (req, res) => {
  if (!isBot(req)) return res.status(403).json({ ok: false, error: "Forbidden" });
  const ip = safeStr(req.body?.ip, 128);
  const seconds = clampInt(req.body?.seconds ?? 3600, 3600, 60, 365*24*3600);
  db.bans.ip.set(ip, { until: now() + seconds * 1000, permanent: false, strikes: 1 });
  return res.json({ ok: true });
});

// Bot announcement to global (special message kind)
app.post("/api/bot/announce", (req, res) => {
  if (!isBot(req)) return res.status(403).json({ ok: false, error: "Forbidden" });
  const text = safeStr(req.body?.text, 2000).trim();
  if (!text) return res.status(400).json({ ok: false, error: "Empty" });

  const msg = {
    id: nanoid(12),
    ts: now(),
    text,
    scope: "global",
    targetId: null,
    kind: "announcement",
    user: { id: "system", username: "tonkotsu", color: "#ffd278" }
  };
  pushMessage(db.messages.global, msg, 800);
  io.emit("message:new", msg);
  return res.json({ ok: true, message: msg });
});

function isBot(req) {
  const hdr = req.headers["x-tonkotsu-bot-secret"];
  return typeof hdr === "string" && hdr === ADMIN_SHARED_SECRET;
}

function clampInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function findMessageById(scope, targetId, messageId) {
  if (scope === "global") return db.messages.global.find(m => m.id === messageId) || null;
  if (scope === "dm") {
    if (!targetId) return null;
    // We don't know both ids; search all dm threads (fine for dev, not prod)
    for (const list of db.messages.dm.values()) {
      const m = list.find(x => x.id === messageId);
      if (m) return m;
    }
    return null;
  }
  if (scope === "group") {
    const list = db.messages.group.get(targetId) || [];
    return list.find(m => m.id === messageId) || null;
  }
  return null;
}

function deleteMessageById(scope, targetId, messageId, me) {
  if (scope === "global") {
    const list = db.messages.global;
    const idx = list.findIndex(m => m.id === messageId);
    if (idx < 0) return false;
    if (!canEditOrDelete(list[idx], me)) return false;
    list.splice(idx, 1);
    return true;
  }
  if (scope === "group") {
    const list = db.messages.group.get(targetId) || [];
    const idx = list.findIndex(m => m.id === messageId);
    if (idx < 0) return false;
    if (!canEditOrDelete(list[idx], me)) return false;
    list.splice(idx, 1);
    db.messages.group.set(targetId, list);
    return true;
  }
  if (scope === "dm") {
    for (const [k, list] of db.messages.dm.entries()) {
      const idx = list.findIndex(m => m.id === messageId);
      if (idx < 0) continue;
      if (!canEditOrDelete(list[idx], me)) return false;
      list.splice(idx, 1);
      db.messages.dm.set(k, list);
      return true;
    }
    return false;
  }
  return false;
}

function emitEdit(scope, targetId, msg) {
  if (scope === "global") io.emit("message:edit", msg);
  else if (scope === "group") emitToGroup(targetId, "message:edit", msg);
  else if (scope === "dm") {
    // emit to both participants by scanning dm thread
    emitToUsers(getDmParticipants(msg), "message:edit", msg);
  }
}

function emitDelete(scope, targetId, messageId) {
  const payload = { messageId, scope, targetId: targetId || null };
  if (scope === "global") io.emit("message:delete", payload);
  else if (scope === "group") emitToGroup(targetId, "message:delete", payload);
  else if (scope === "dm") io.emit("message:delete", payload); // fine for dev; tighten later
}

function getDmParticipants(msg) {
  // in this baseline, dm messages store targetId = peerId
  // sender is msg.user.id
  const a = msg.user?.id;
  const b = msg.targetId;
  return [a, b].filter(Boolean);
}

// -------------------------
// Socket.IO presence + unique online users
// -------------------------
const online = {
  // userId -> Set(socketId)
  socketsByUserId: new Map(),
  // socketId -> userId
  userIdBySocketId: new Map(),
  // userId -> mode
  presence: new Map()
};

io.on("connection", (socket) => {
  // token may be in handshake auth
  const token = socket.handshake.auth?.token || null;
  let user = null;

  try {
    const userId = token ? verifyToken(token) : null;
    user = userId ? db.usersById.get(userId) : null;
  } catch {}

  if (!user) {
    socket.disconnect(true);
    return;
  }

  // register
  online.userIdBySocketId.set(socket.id, user.id);
  if (!online.socketsByUserId.has(user.id)) online.socketsByUserId.set(user.id, new Set());
  online.socketsByUserId.get(user.id).add(socket.id);

  // default presence
  if (!online.presence.has(user.id)) online.presence.set(user.id, "online");

  // join rooms by userId, plus group rooms
  socket.join(`user:${user.id}`);
  const groups = Array.from(db.groups.values()).filter(g => (db.groupMembers.get(g.id) || new Set()).has(user.id));
  for (const g of groups) socket.join(`group:${g.id}`);

  broadcastOnline();

  socket.on("presence:set", (p) => {
    const mode = safeStr(p?.mode, 16);
    const allowed = new Set(["online", "idle", "dnd", "invisible"]);
    if (!allowed.has(mode)) return;
    online.presence.set(user.id, mode);
    broadcastOnline();
  });

  socket.on("disconnect", () => {
    online.userIdBySocketId.delete(socket.id);
    const set = online.socketsByUserId.get(user.id);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        online.socketsByUserId.delete(user.id);
        online.presence.delete(user.id);
      }
    }
    broadcastOnline();
  });
});

function getOnlineUsersList() {
  const out = [];
  for (const [userId, sockSet] of online.socketsByUserId.entries()) {
    const u = db.usersById.get(userId);
    if (!u) continue;
    out.push({
      id: u.id,
      username: u.username,
      mode: online.presence.get(userId) || "online"
    });
  }
  // stable order
  out.sort((a, b) => a.username.localeCompare(b.username));
  return out;
}

function broadcastOnline() {
  const users = getOnlineUsersList();
  io.emit("users:online", { users, count: users.length });
}

function emitToUsers(userIds, event, payload) {
  const uniq = Array.from(new Set(userIds.filter(Boolean)));
  for (const uid of uniq) io.to(`user:${uid}`).emit(event, payload);
}

function emitToGroup(groupId, event, payload) {
  io.to(`group:${groupId}`).emit(event, payload);
}

function emitToAdmins(event, payload) {
  // baseline: anyone with "Owner" badge is admin
  for (const [id, u] of db.usersById.entries()) {
    if ((u.badges || []).includes("Owner")) io.to(`user:${id}`).emit(event, payload);
  }
}

function eraseUser(userId) {
  const u = db.usersById.get(userId);
  if (!u) return;

  // remove from user maps
  db.usersById.delete(userId);
  db.usersByUsername.delete(lower(u.username));

  // remove from friends sets
  for (const [k, set] of db.friends.entries()) {
    if (set.has(userId)) set.delete(userId);
  }
  db.friends.delete(userId);

  // remove from group members
  for (const [gid, set] of db.groupMembers.entries()) {
    if (set.has(userId)) set.delete(userId);
  }

  // kick sockets
  const sockSet = online.socketsByUserId.get(userId);
  if (sockSet) {
    for (const sid of sockSet) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.disconnect(true);
    }
  }
}

// -------------------------
// Seed admin
// -------------------------
function seedAdminUser() {
  const username = "owner";
  if (db.usersByUsername.has(lower(username))) return;

  const id = nanoid(10);
  const pass = "changeme"; // change immediately
  const passHash = bcrypt.hashSync(pass, 10);
  const u = {
    id,
    username,
    passHash,
    color: "#ffd278",
    badges: ["Owner", "Early Access"],
    createdAt: now(),
    lastSeen: now(),
    bio: "Site owner."
  };
  db.usersById.set(id, u);
  db.usersByUsername.set(lower(username), u);
  db.friends.set(id, new Set());
}

// -------------------------
server.listen(PORT, () => {
  console.log(`tonkotsu server listening on :${PORT}`);
});
