// server.js
// tonkotsu.online — compact black chat server (Express + Socket.IO)
//
// Fixes your PORT error:
// - PORT is declared ONCE (top-level) and never redeclared.
//
// Also fixes “can’t sign in / guest not working” common causes:
// - Serves "/" (index.html) so no "Cannot GET /"
// - Uses a simple JSON store (data/store.json) so users persist
// - Implements: login, register (auto-register on first login), guest, logout
// - Enforces: one account per day per device (via deviceId header/cookie), one-session-per-account
//
// NOTE: Put your client files in:
//   public/index.html
//   public/script.js
//
// And ensure package.json includes dependencies:
//   express socket.io bcryptjs nanoid cookie-parser cors
//
// ENV (optional):
//   PORT=3000
//   DISCORD_WEBHOOK_URL=...
//   ADMIN_KEY=...               (for admin endpoints, if you add later)
//   TRUST_PROXY_HOPS=1          (Render usually 1)
//
// Run: node server.js

"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");

const express = require("express");
const cookieParser = require("cookie-parser");
const cors = require("cors");

const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");
const { Server } = require("socket.io");

/* -----------------------------
   Environment (DECLARE ONCE)
----------------------------- */

const PORT = Number(process.env.PORT || 3000);
const DISCORD_WEBHOOK_URL = String(process.env.DISCORD_WEBHOOK_URL || "").trim();
const ADMIN_KEY = String(process.env.ADMIN_KEY || "").trim();
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS || 1);

/* -----------------------------
   App + Server
----------------------------- */

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true },
});

app.set("trust proxy", TRUST_PROXY_HOPS);
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

/* -----------------------------
   Paths / Storage
----------------------------- */

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonSafe(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("writeJsonSafe failed:", e.message);
  }
}

const store = readJsonSafe(STORE_FILE, {
  usersById: {},
  usersByName: {},
  sessionsByToken: {}, // token -> { userId, createdAt, deviceId, ip }
  activeTokenByUserId: {}, // userId -> token (one-session-per-account)
  deviceAccountDay: {}, // deviceId -> { dayKey, count }
  globalMessages: [],
  dmThreads: {}, // key "a|b" -> messages[]
  groupChats: {}, // groupId -> { id, name, ownerId, limit, cooldownSeconds, rules, members:[], invites:[] }
  groupMessages: {}, // groupId -> messages[]
  whatsNew: [],
  lastRead: {}, // userId -> { global, dm:{peerId:msgId}, group:{gid:msgId} }
  friends: {}, // userId -> [friendUserIds]
});

function persist() {
  writeJsonSafe(STORE_FILE, store);
}

/* -----------------------------
   Helpers
----------------------------- */

function now() {
  return Date.now();
}

function dayKeyUTC(ts = Date.now()) {
  const d = new Date(ts);
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function getIP(req) {
  // Trust proxy configured. express will set req.ip.
  return String(req.ip || req.connection?.remoteAddress || "").slice(0, 128);
}

function getDeviceId(req, res) {
  // deviceId from header first, else cookie, else set cookie.
  const hdr = String(req.headers["x-device-id"] || "").trim();
  const cookie = String(req.cookies?.tk_device || "").trim();

  let id = hdr || cookie;
  if (!id) {
    id = nanoid(16);
    // 365d cookie
    res.cookie("tk_device", id, {
      httpOnly: false,
      sameSite: "lax",
      secure: false,
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });
  }
  return id;
}

function safeUsername(u) {
  return String(u || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\.]/g, "")
    .slice(0, 20);
}

function ensureUserRecordByUsername(usernameLower) {
  const id = store.usersByName[usernameLower];
  if (!id) return null;
  return store.usersById[id] || null;
}

function makeUserPublic(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    badges: user.badges || [],
    status: user.status || "online",
    createdAt: user.createdAt || 0,
  };
}

function ensureLastRead(userId) {
  if (!store.lastRead[userId]) {
    store.lastRead[userId] = { global: null, dm: {}, group: {} };
  }
  return store.lastRead[userId];
}

function dmKey(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function pushMessage(list, msg, max = 600) {
  list.push(msg);
  if (list.length > max) list.splice(0, list.length - max);
}

function genToken() {
  return nanoid(40);
}

function revokeUserSession(userId, reason = "revoked") {
  const prev = store.activeTokenByUserId[userId];
  if (prev && store.sessionsByToken[prev]) {
    delete store.sessionsByToken[prev];
  }
  store.activeTokenByUserId[userId] = null;

  // Notify sockets if any are connected for that userId
  for (const [sid, sock] of io.of("/").sockets) {
    if (sock.data?.userId === userId) {
      sock.emit("session:revoked", { reason });
      try {
        sock.disconnect(true);
      } catch {}
    }
  }
}

function authFromReq(req) {
  const h = String(req.headers.authorization || "");
  const token = h.startsWith("Bearer ") ? h.slice(7).trim() : "";
  if (!token) return null;
  const s = store.sessionsByToken[token];
  if (!s) return null;
  const u = store.usersById[s.userId];
  if (!u) return null;
  return { token, session: s, user: u };
}

function requireAuth(req, res, next) {
  const a = authFromReq(req);
  if (!a) return res.status(401).json({ ok: false, error: "Unauthorized" });
  req.auth = a;
  next();
}

/* -----------------------------
   Serve site (fix Cannot GET /)
----------------------------- */

// Serve static assets in /public
app.use("/public", express.static(PUBLIC_DIR, { extensions: ["js"] }));

// Root serves index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// Optional: allow direct access too
app.get("/index.html", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* -----------------------------
   Auth / Account Rules
----------------------------- */

function deviceDailyGate(deviceId) {
  const key = dayKeyUTC();
  const rec = store.deviceAccountDay[deviceId] || { dayKey: key, count: 0 };
  if (rec.dayKey !== key) {
    rec.dayKey = key;
    rec.count = 0;
  }
  store.deviceAccountDay[deviceId] = rec;
  return rec;
}

// “One account per day” is enforced when a NEW user is created.
function canCreateAccountToday(deviceId) {
  const rec = deviceDailyGate(deviceId);
  return rec.count < 1;
}

function noteAccountCreated(deviceId) {
  const rec = deviceDailyGate(deviceId);
  rec.count += 1;
  store.deviceAccountDay[deviceId] = rec;
}

// Create user (internal)
async function createUser(usernameLower, passwordPlain, { isGuest = false } = {}) {
  const id = nanoid(14);
  const username = usernameLower;

  const pwHash = isGuest ? "" : await bcrypt.hash(String(passwordPlain || ""), 10);

  const user = {
    id,
    username,
    pwHash,
    isGuest: !!isGuest,
    badges: [],
    status: "online",
    createdAt: now(),
    lastSeen: now(),
  };

  store.usersById[id] = user;
  store.usersByName[username] = id;

  // init friends list
  if (!store.friends[id]) store.friends[id] = [];

  // init last read
  ensureLastRead(id);

  persist();
  return user;
}

function issueSession(req, res, userId) {
  // enforce one-session-per-account
  revokeUserSession(userId, "signed_in_elsewhere");

  const token = genToken();
  const deviceId = getDeviceId(req, res);
  const ip = getIP(req);

  store.sessionsByToken[token] = {
    userId,
    createdAt: now(),
    deviceId,
    ip,
  };
  store.activeTokenByUserId[userId] = token;
  persist();

  return token;
}

/* -----------------------------
   API: Auth
----------------------------- */

// Login (auto-register if username doesn't exist)
app.post("/api/auth/login", async (req, res) => {
  const deviceId = getDeviceId(req, res);
  const ip = getIP(req);

  const username = safeUsername(req.body?.username);
  const password = String(req.body?.password || "");

  if (!username) return res.status(400).json({ ok: false, error: "Missing username" });
  if (!password) return res.status(400).json({ ok: false, error: "Missing password" });

  let user = ensureUserRecordByUsername(username);

  if (!user) {
    // auto-register
    if (!canCreateAccountToday(deviceId)) {
      return res.status(429).json({
        ok: false,
        error: "Account creation limit reached (1/day per device).",
      });
    }

    user = await createUser(username, password, { isGuest: false });
    noteAccountCreated(deviceId);
  } else {
    // existing user
    if (user.isGuest) {
      return res.status(403).json({ ok: false, error: "Guest accounts cannot be password-signed-in." });
    }
    const ok = await bcrypt.compare(password, user.pwHash || "");
    if (!ok) {
      return res.status(401).json({ ok: false, error: "Invalid username or password." });
    }
  }

  user.lastSeen = now();
  user.lastIP = ip;

  const token = issueSession(req, res, user.id);
  return res.json({ ok: true, token, user: makeUserPublic(user) });
});

// Guest login
app.post("/api/auth/guest", async (req, res) => {
  const deviceId = getDeviceId(req, res);
  const ip = getIP(req);

  // guest is allowed without daily account gate (not a real account)
  const guestName = `guest_${nanoid(6).toLowerCase()}`;
  const user = await createUser(guestName, "", { isGuest: true });

  user.lastSeen = now();
  user.lastIP = ip;

  const token = issueSession(req, res, user.id);
  return res.json({ ok: true, token, user: makeUserPublic(user) });
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  const a = authFromReq(req);
  if (a?.token) {
    delete store.sessionsByToken[a.token];
    if (store.activeTokenByUserId[a.user.id] === a.token) {
      store.activeTokenByUserId[a.user.id] = null;
    }
    persist();
  }
  return res.json({ ok: true });
});

/* -----------------------------
   API: Me / Settings
----------------------------- */

app.get("/api/users/me", requireAuth, (req, res) => {
  const u = req.auth.user;
  return res.json({ ok: true, user: makeUserPublic(u) });
});

app.get("/api/settings", requireAuth, (req, res) => {
  const u = req.auth.user;
  u.settings = u.settings || {};
  persist();
  return res.json({ ok: true, settings: u.settings });
});

app.post("/api/settings", requireAuth, (req, res) => {
  const u = req.auth.user;
  const settings = req.body?.settings;
  if (!settings || typeof settings !== "object") {
    return res.status(400).json({ ok: false, error: "Invalid settings" });
  }
  u.settings = settings;
  persist();
  return res.json({ ok: true, settings: u.settings });
});

/* -----------------------------
   API: Bootstrap State
----------------------------- */

app.get("/api/state/bootstrap", requireAuth, (req, res) => {
  const me = req.auth.user;
  const lr = ensureLastRead(me.id);

  // Global
  const global = {
    messages: store.globalMessages.slice(-200),
    cursor: store.globalMessages[0]?.id || null,
    hasMore: store.globalMessages.length > 200,
  };

  // Friends + DMs
  const friendIds = store.friends[me.id] || [];
  const friends = friendIds
    .map((id) => makeUserPublic(store.usersById[id]))
    .filter(Boolean);

  const dms = [];
  for (const fid of friendIds) {
    const key = dmKey(me.id, fid);
    const msgs = store.dmThreads[key] || [];
    const peer = store.usersById[fid];
    dms.push({
      peer: makeUserPublic(peer),
      messages: msgs.slice(-120),
      cursor: msgs[0]?.id || null,
      hasMore: msgs.length > 120,
      lastRead: lr.dm[fid] || null,
    });
  }

  // Groups
  const groups = Object.values(store.groupChats).filter((g) => Array.isArray(g.members) && g.members.includes(me.id));
  const groupThreads = groups.map((g) => {
    const msgs = store.groupMessages[g.id] || [];
    return {
      group: {
        id: g.id,
        name: g.name,
        ownerId: g.ownerId,
        ownerUsername: store.usersById[g.ownerId]?.username || "",
        limit: g.limit,
        cooldownSeconds: g.cooldownSeconds,
        rules: g.rules || "",
      },
      messages: msgs.slice(-140),
      cursor: msgs[0]?.id || null,
      hasMore: msgs.length > 140,
      lastRead: lr.group[g.id] || null,
    };
  });

  // Online count is best-effort
  const onlineCount = io.of("/").sockets.size;

  return res.json({
    ok: true,
    global,
    friends,
    dms,
    groups,
    groupThreads,
    whatsNew: store.whatsNew || [],
    lastRead: lr,
    onlineCount,
  });
});

/* -----------------------------
   API: Messages
----------------------------- */

function messageObj({ scope, targetId, user, text, clientId }) {
  return {
    id: nanoid(14),
    clientId: clientId || null,
    scope,
    targetId: targetId || null,
    ts: now(),
    text: String(text || "").slice(0, 3000),
    editedAt: null,
    user: makeUserPublic(user),
  };
}

function globalFilter(text) {
  // Server-side minimal enforcement (client also filters).
  // Keep it strict-ish for 18+; mild profanity optional.
  const t = String(text || "").toLowerCase();
  const hard = ["rape", "cp", "child porn", "kys", "kill yourself", "bomb threat", "shoot up"];
  const adult = ["porn", "hentai", "xxx", "onlyfans", "nsfw", "nudes", "blowjob", "handjob"];
  for (const w of hard) if (t.includes(w)) return { blocked: true, word: w };
  for (const w of adult) if (t.includes(w)) return { blocked: true, word: w };
  return { blocked: false };
}

app.get("/api/messages/global", requireAuth, (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 60)));
  const before = String(req.query.before || "").trim();

  let msgs = store.globalMessages;
  if (before) {
    const idx = msgs.findIndex((m) => m.id === before);
    if (idx > 0) msgs = msgs.slice(0, idx);
  }
  const out = msgs.slice(-limit);
  const cursor = msgs[0]?.id || null;
  const hasMore = msgs.length > limit;

  res.json({ ok: true, messages: out, cursor, hasMore });
});

app.get("/api/messages/dm/:peerId", requireAuth, (req, res) => {
  const me = req.auth.user;
  const peerId = String(req.params.peerId || "");
  const peer = store.usersById[peerId];

  if (!peer) return res.status(404).json({ ok: false, error: "User not found" });

  const key = dmKey(me.id, peerId);
  const msgsAll = store.dmThreads[key] || [];

  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 60)));
  const before = String(req.query.before || "").trim();

  let msgs = msgsAll;
  if (before) {
    const idx = msgs.findIndex((m) => m.id === before);
    if (idx > 0) msgs = msgs.slice(0, idx);
  }

  const out = msgs.slice(-limit);
  const cursor = msgs[0]?.id || null;
  const hasMore = msgs.length > limit;

  res.json({ ok: true, peer: makeUserPublic(peer), messages: out, cursor, hasMore });
});

app.get("/api/messages/group/:groupId", requireAuth, (req, res) => {
  const me = req.auth.user;
  const gid = String(req.params.groupId || "");
  const g = store.groupChats[gid];
  if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
  if (!g.members.includes(me.id)) return res.status(403).json({ ok: false, error: "Not a member" });

  const all = store.groupMessages[gid] || [];
  const limit = Math.max(1, Math.min(200, Number(req.query.limit || 70)));
  const before = String(req.query.before || "").trim();

  let msgs = all;
  if (before) {
    const idx = msgs.findIndex((m) => m.id === before);
    if (idx > 0) msgs = msgs.slice(0, idx);
  }
  const out = msgs.slice(-limit);
  const cursor = msgs[0]?.id || null;
  const hasMore = msgs.length > limit;

  res.json({
    ok: true,
    group: {
      id: g.id,
      name: g.name,
      ownerId: g.ownerId,
      ownerUsername: store.usersById[g.ownerId]?.username || "",
      limit: g.limit,
      cooldownSeconds: g.cooldownSeconds,
      rules: g.rules || "",
    },
    messages: out,
    cursor,
    hasMore,
  });
});

app.post("/api/messages/send", requireAuth, (req, res) => {
  const me = req.auth.user;
  const scope = String(req.body?.scope || "");
  const targetId = req.body?.targetId ? String(req.body.targetId) : null;
  const text = String(req.body?.text || "").trim();
  const clientId = req.body?.clientId ? String(req.body.clientId) : null;

  if (!text) return res.status(400).json({ ok: false, error: "Empty message" });

  // enforce by scope
  if (scope === "global") {
    const f = globalFilter(text);
    if (f.blocked) return res.status(403).json({ ok: false, error: `Blocked word: ${f.word}` });

    const m = messageObj({ scope, targetId: null, user: me, text, clientId });
    pushMessage(store.globalMessages, m, 900);
    persist();

    io.emit("message:new", m);
    return res.json({ ok: true, message: m });
  }

  if (scope === "dm") {
    if (!targetId) return res.status(400).json({ ok: false, error: "Missing targetId" });
    const peer = store.usersById[targetId];
    if (!peer) return res.status(404).json({ ok: false, error: "User not found" });

    const key = dmKey(me.id, targetId);
    if (!store.dmThreads[key]) store.dmThreads[key] = [];
    const m = messageObj({ scope, targetId, user: me, text, clientId });

    pushMessage(store.dmThreads[key], m, 800);
    persist();

    // emit to both users
    emitToUser(me.id, "message:new", m);
    emitToUser(targetId, "message:new", m);

    return res.json({ ok: true, message: m });
  }

  if (scope === "group") {
    if (!targetId) return res.status(400).json({ ok: false, error: "Missing groupId" });
    const g = store.groupChats[targetId];
    if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
    if (!g.members.includes(me.id)) return res.status(403).json({ ok: false, error: "Not a member" });

    // cooldown enforcement (simple per-user per-group)
    g.cooldowns = g.cooldowns || {}; // userId -> untilTs
    const until = Number(g.cooldowns[me.id] || 0);
    if (until && now() < until) {
      return res.status(429).json({ ok: false, error: "Cooldown active", cooldownUntil: until });
    }
    const cd = Math.max(0, Number(g.cooldownSeconds || 0));
    if (cd > 0) g.cooldowns[me.id] = now() + cd * 1000;

    if (!store.groupMessages[targetId]) store.groupMessages[targetId] = [];
    const m = messageObj({ scope, targetId, user: me, text, clientId });

    pushMessage(store.groupMessages[targetId], m, 1200);
    persist();

    io.to(`group:${targetId}`).emit("message:new", m);
    return res.json({ ok: true, message: m, cooldownUntil: g.cooldowns[me.id] || 0 });
  }

  return res.status(400).json({ ok: false, error: "Invalid scope" });
});

// Edit/Delete within 1 minute (server-enforced)
app.post("/api/messages/edit", requireAuth, (req, res) => {
  const me = req.auth.user;
  const messageId = String(req.body?.messageId || "");
  const text = String(req.body?.text || "").trim();

  if (!messageId) return res.status(400).json({ ok: false, error: "Missing messageId" });
  if (!text) return res.status(400).json({ ok: false, error: "Empty text" });

  const edited = findAndEditMessage(me, messageId, text);
  if (!edited.ok) return res.status(edited.status).json({ ok: false, error: edited.error });

  persist();
  const m = edited.message;

  // notify
  if (m.scope === "global") io.emit("message:edit", m);
  else if (m.scope === "dm") {
    const peerId = m.targetId;
    emitToUser(me.id, "message:edit", m);
    emitToUser(peerId, "message:edit", m);
  } else if (m.scope === "group") {
    io.to(`group:${m.targetId}`).emit("message:edit", m);
  }

  res.json({ ok: true, message: m });
});

app.post("/api/messages/delete", requireAuth, (req, res) => {
  const me = req.auth.user;
  const messageId = String(req.body?.messageId || "");

  if (!messageId) return res.status(400).json({ ok: false, error: "Missing messageId" });

  const del = findAndDeleteMessage(me, messageId);
  if (!del.ok) return res.status(del.status).json({ ok: false, error: del.error });

  persist();

  const payload = { messageId, scope: del.scope, targetId: del.targetId || null };

  if (del.scope === "global") io.emit("message:delete", payload);
  else if (del.scope === "dm") {
    emitToUser(del.a, "message:delete", payload);
    emitToUser(del.b, "message:delete", payload);
  } else if (del.scope === "group") {
    io.to(`group:${del.targetId}`).emit("message:delete", payload);
  }

  res.json({ ok: true });
});

function findAndEditMessage(me, messageId, newText) {
  const windowMs = 60_000;

  // global
  for (const m of store.globalMessages) {
    if (m.id === messageId) {
      if (m.user?.id !== me.id) return { ok: false, status: 403, error: "Not your message" };
      if (now() - m.ts > windowMs) return { ok: false, status: 403, error: "Edit window expired" };
      const f = globalFilter(newText);
      if (f.blocked) return { ok: false, status: 403, error: `Blocked word: ${f.word}` };
      m.text = newText;
      m.editedAt = now();
      return { ok: true, message: m };
    }
  }

  // dms
  for (const [key, arr] of Object.entries(store.dmThreads)) {
    const idx = arr.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      const m = arr[idx];
      if (m.user?.id !== me.id) return { ok: false, status: 403, error: "Not your message" };
      if (now() - m.ts > windowMs) return { ok: false, status: 403, error: "Edit window expired" };
      m.text = newText;
      m.editedAt = now();
      return { ok: true, message: m };
    }
  }

  // groups
  for (const [gid, arr] of Object.entries(store.groupMessages)) {
    const idx = arr.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      const m = arr[idx];
      if (m.user?.id !== me.id) return { ok: false, status: 403, error: "Not your message" };
      if (now() - m.ts > windowMs) return { ok: false, status: 403, error: "Edit window expired" };
      m.text = newText;
      m.editedAt = now();
      return { ok: true, message: m };
    }
  }

  return { ok: false, status: 404, error: "Message not found" };
}

function findAndDeleteMessage(me, messageId) {
  const windowMs = 60_000;

  // global
  {
    const idx = store.globalMessages.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      const m = store.globalMessages[idx];
      if (m.user?.id !== me.id) return { ok: false, status: 403, error: "Not your message" };
      if (now() - m.ts > windowMs) return { ok: false, status: 403, error: "Delete window expired" };
      store.globalMessages.splice(idx, 1);
      return { ok: true, scope: "global", targetId: null };
    }
  }

  // dms
  for (const [key, arr] of Object.entries(store.dmThreads)) {
    const idx = arr.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      const m = arr[idx];
      if (m.user?.id !== me.id) return { ok: false, status: 403, error: "Not your message" };
      if (now() - m.ts > windowMs) return { ok: false, status: 403, error: "Delete window expired" };
      arr.splice(idx, 1);
      const [a, b] = key.split("|");
      return { ok: true, scope: "dm", targetId: m.targetId, a, b };
    }
  }

  // groups
  for (const [gid, arr] of Object.entries(store.groupMessages)) {
    const idx = arr.findIndex((m) => m.id === messageId);
    if (idx >= 0) {
      const m = arr[idx];
      if (m.user?.id !== me.id) return { ok: false, status: 403, error: "Not your message" };
      if (now() - m.ts > windowMs) return { ok: false, status: 403, error: "Delete window expired" };
      arr.splice(idx, 1);
      return { ok: true, scope: "group", targetId: gid };
    }
  }

  return { ok: false, status: 404, error: "Message not found" };
}

/* -----------------------------
   API: Reporting (webhook)
----------------------------- */

async function postToDiscordWebhook(payload) {
  if (!DISCORD_WEBHOOK_URL) return false;
  try {
    const fetch = global.fetch || require("node-fetch");
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch (e) {
    console.warn("Webhook failed:", e.message);
    return false;
  }
}

app.post("/api/messages/report", requireAuth, async (req, res) => {
  const me = req.auth.user;
  const messageId = String(req.body?.messageId || "");
  const reason = String(req.body?.reason || "").slice(0, 500);

  if (!messageId) return res.status(400).json({ ok: false, error: "Missing messageId" });

  // Find message metadata
  const found = findMessageAnyScope(messageId);
  if (!found) return res.status(404).json({ ok: false, error: "Message not found" });

  const payload = {
    username: "tonkotsu.online",
    content: null,
    embeds: [
      {
        title: "Message Report",
        description: "A message was reported.",
        fields: [
          { name: "Reporter", value: me.username, inline: true },
          { name: "Message ID", value: messageId, inline: true },
          { name: "Scope", value: found.scope, inline: true },
          { name: "Target", value: found.targetId || "—", inline: true },
          { name: "Author", value: found.message.user?.username || "—", inline: true },
          { name: "Reason", value: reason || "—", inline: false },
          { name: "Text", value: String(found.message.text || "").slice(0, 900) || "—", inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  await postToDiscordWebhook(payload);
  return res.json({ ok: true });
});

function findMessageAnyScope(messageId) {
  for (const m of store.globalMessages) {
    if (m.id === messageId) return { scope: "global", targetId: null, message: m };
  }
  for (const [key, arr] of Object.entries(store.dmThreads)) {
    const m = arr.find((x) => x.id === messageId);
    if (m) return { scope: "dm", targetId: m.targetId || null, message: m };
  }
  for (const [gid, arr] of Object.entries(store.groupMessages)) {
    const m = arr.find((x) => x.id === messageId);
    if (m) return { scope: "group", targetId: gid, message: m };
  }
  return null;
}

/* -----------------------------
   API: Groups (minimal)
----------------------------- */

app.get("/api/groups", requireAuth, (req, res) => {
  const me = req.auth.user;
  const groups = Object.values(store.groupChats)
    .filter((g) => Array.isArray(g.members) && g.members.includes(me.id))
    .map((g) => ({
      id: g.id,
      name: g.name,
      ownerId: g.ownerId,
      ownerUsername: store.usersById[g.ownerId]?.username || "",
      limit: g.limit,
      cooldownSeconds: g.cooldownSeconds,
      rules: g.rules || "",
    }));
  res.json({ ok: true, groups });
});

app.post("/api/groups/create", requireAuth, (req, res) => {
  const me = req.auth.user;
  const name = String(req.body?.name || "Group Chat").slice(0, 40);
  const limit = Math.max(2, Math.min(200, Number(req.body?.limit || 10)));
  const cooldownSeconds = Math.max(0, Math.min(30, Number(req.body?.cooldownSeconds || 2)));

  const id = nanoid(12);
  store.groupChats[id] = {
    id,
    name,
    ownerId: me.id,
    limit,
    cooldownSeconds,
    rules: "",
    members: [me.id],
    invites: [],
    cooldowns: {},
  };
  store.groupMessages[id] = store.groupMessages[id] || [];
  persist();

  res.json({ ok: true, group: { id, name, ownerId: me.id, limit, cooldownSeconds, rules: "" } });
  emitToUser(me.id, "groups:update", { groups: Object.values(store.groupChats).filter(g => g.members.includes(me.id)) });
});

app.post("/api/groups/update", requireAuth, (req, res) => {
  const me = req.auth.user;
  const groupId = String(req.body?.groupId || "");
  const patch = req.body?.patch || {};

  const g = store.groupChats[groupId];
  if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
  if (g.ownerId !== me.id) return res.status(403).json({ ok: false, error: "Owner only" });

  if (typeof patch.name === "string") g.name = patch.name.slice(0, 40) || g.name;
  if (patch.limit != null) g.limit = Math.max(2, Math.min(200, Number(patch.limit || g.limit)));
  if (patch.cooldownSeconds != null) g.cooldownSeconds = Math.max(0, Math.min(30, Number(patch.cooldownSeconds || g.cooldownSeconds)));
  if (typeof patch.rules === "string") g.rules = patch.rules.slice(0, 700);

  persist();

  const pub = {
    id: g.id,
    name: g.name,
    ownerId: g.ownerId,
    ownerUsername: store.usersById[g.ownerId]?.username || "",
    limit: g.limit,
    cooldownSeconds: g.cooldownSeconds,
    rules: g.rules || "",
  };

  io.to(`group:${g.id}`).emit("groups:update", { groups: Object.values(store.groupChats) });
  res.json({ ok: true, group: pub });
});

app.post("/api/groups/inviteLink", requireAuth, (req, res) => {
  const me = req.auth.user;
  const groupId = String(req.body?.groupId || "");
  const g = store.groupChats[groupId];
  if (!g) return res.status(404).json({ ok: false, error: "Group not found" });
  if (g.ownerId !== me.id) return res.status(403).json({ ok: false, error: "Owner only" });

  const code = nanoid(10);
  g.invites = g.invites || [];
  g.invites.push({ code, createdAt: now() });
  // cap invites
  if (g.invites.length > 30) g.invites.splice(0, g.invites.length - 30);

  persist();

  // Owner must approve/add; link is informational in this build
  const link = `/invite/${code}`;
  res.json({ ok: true, link });
});

/* -----------------------------
   Socket.IO
----------------------------- */

function emitToUser(userId, event, payload) {
  for (const [sid, sock] of io.of("/").sockets) {
    if (sock.data?.userId === userId) sock.emit(event, payload);
  }
}

io.on("connection", (socket) => {
  socket.data.userId = null;

  socket.on("auth", (payload) => {
    const token = String(payload?.token || "").trim();
    const s = store.sessionsByToken[token];
    if (!s) {
      socket.emit("session:revoked", { reason: "invalid_token" });
      try { socket.disconnect(true); } catch {}
      return;
    }

    const u = store.usersById[s.userId];
    if (!u) {
      socket.emit("session:revoked", { reason: "missing_user" });
      try { socket.disconnect(true); } catch {}
      return;
    }

    socket.data.userId = u.id;
    u.status = u.status || "online";
    u.lastSeen = now();
    persist();

    socket.emit("presence:update", { me: { mode: u.status } });
    io.emit("users:online", { count: io.of("/").sockets.size });
  });

  socket.on("presence:set", (payload) => {
    const uid = socket.data.userId;
    if (!uid) return;
    const u = store.usersById[uid];
    if (!u) return;

    const mode = String(payload?.mode || "online");
    const allowed = new Set(["online", "idle", "dnd", "invisible"]);
    u.status = allowed.has(mode) ? mode : "online";
    u.lastSeen = now();
    persist();

    io.emit("presence:update", { me: { mode: u.status }, user: u.username, status: u.status });
  });

  socket.on("groups:join", (payload) => {
    const uid = socket.data.userId;
    const gid = String(payload?.groupId || "");
    if (!uid || !gid) return;

    const g = store.groupChats[gid];
    if (!g) return;
    if (!g.members.includes(uid)) return;

    socket.join(`group:${gid}`);
  });

  socket.on("dm:open", (payload) => {
    // No room join needed; server emits directly by userId.
    void payload;
  });

  socket.on("typing", (payload) => {
    const uid = socket.data.userId;
    if (!uid) return;

    const scope = String(payload?.scope || "");
    const targetId = payload?.targetId ? String(payload.targetId) : null;
    const typing = !!payload?.typing;

    const me = store.usersById[uid];
    const u = me ? makeUserPublic(me) : { id: uid, username: "user" };

    // relay typing only to relevant audience
    if (scope === "global") {
      io.emit("typing:update", { scope: "global", targetId: null, users: typing ? [u] : [] });
      return;
    }

    if (scope === "dm" && targetId) {
      emitToUser(uid, "typing:update", { scope: "dm", targetId, users: typing ? [u] : [] });
      emitToUser(targetId, "typing:update", { scope: "dm", targetId, users: typing ? [u] : [] });
      return;
    }

    if (scope === "group" && targetId) {
      io.to(`group:${targetId}`).emit("typing:update", { scope: "group", targetId, users: typing ? [u] : [] });
      return;
    }
  });

  socket.on("read", (payload) => {
    const uid = socket.data.userId;
    if (!uid) return;

    const scope = String(payload?.scope || "");
    const targetId = payload?.targetId ? String(payload.targetId) : null;
    const messageId = payload?.messageId ? String(payload.messageId) : null;
    if (!messageId) return;

    const lr = ensureLastRead(uid);
    if (scope === "global") lr.global = messageId;
    else if (scope === "dm" && targetId) lr.dm[targetId] = messageId;
    else if (scope === "group" && targetId) lr.group[targetId] = messageId;

    persist();

    // optional broadcast
    socket.emit("read:update", { scope, targetId, userId: uid, messageId, ts: now() });
  });

  socket.on("disconnect", () => {
    io.emit("users:online", { count: io.of("/").sockets.size });
  });
});

/* -----------------------------
   Deploy sanity log
----------------------------- */

server.listen(PORT, "0.0.0.0", () => {
  console.log("Listening on", PORT);
});
