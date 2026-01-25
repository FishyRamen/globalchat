// server/server.js
// tonkotsu.online backend (Express + Socket.IO)
// Features:
// - Login/Create account (username+password)
// - Guest accounts (temporary)
// - Public rooms with topics
// - Public group chats + history
// - Owner/admin permissions: promote/demote/ban/unban/topic
// - Presence online count
// Notes:
// - This is a self-contained, file-backed server (JSON storage).
// - For production, swap storage/auth to a real DB and hardened security.

"use strict";

const path = require("path");
const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

const express = require("express");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const compression = require("compression");
const { Server } = require("socket.io");

// -----------------------------
// Config
// -----------------------------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const PUBLIC_DIR = process.env.PUBLIC_DIR || path.join(__dirname, "..", "public");

const TOKEN_SECRET = process.env.TOKEN_SECRET || "dev_secret_change_me_" + crypto.randomBytes(16).toString("hex");
const MAX_HISTORY = 250; // messages per room
const MAX_TEXT = 4000;   // max message length
const USERNAME_MIN = 4;
const USERNAME_MAX = 20;
const TOPIC_MAX = 140;

const DEFAULT_PUBLIC_ROOMS = [
  { id: "global", name: "Global", topic: "Welcome to Global", owner: "system", admins: [], banned: [] },
  { id: "gaming", name: "Gaming", topic: "Talk games + squads", owner: "system", admins: [], banned: [] },
  { id: "school", name: "School", topic: "Homework + exams", owner: "system", admins: [], banned: [] },
  { id: "music", name: "Music", topic: "Songs, artists, playlists", owner: "system", admins: [], banned: [] },
];

// -----------------------------
// Utilities
// -----------------------------
function now() { return Date.now(); }

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function atomicWriteJson(file, obj) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function clampStr(s, maxLen) {
  s = String(s ?? "");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function normalizeUsername(u) {
  return String(u || "").trim();
}

function isValidUsername(u) {
  if (typeof u !== "string") return false;
  if (u.length < USERNAME_MIN || u.length > USERNAME_MAX) return false;
  // allow letters/numbers/_-.
  return /^[A-Za-z0-9_.-]+$/.test(u);
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function pbkdf2Hash(password, salt) {
  const iterations = 150000;
  const keylen = 32;
  const digest = "sha256";
  const dk = crypto.pbkdf2Sync(String(password), String(salt), iterations, keylen, digest);
  return dk.toString("hex");
}

function timingSafeEq(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

// -----------------------------
// File-backed storage
// -----------------------------
ensureDir(DATA_DIR);
const DB_FILE = path.join(DATA_DIR, "db.json");

function defaultDb() {
  return {
    version: 1,
    users: {
      // username: { username, passSalt, passHash, createdAt, isGuest, level }
    },
    tokens: {
      // tokenHash: { username, createdAt, expiresAt }
    },
    rooms: {
      // roomId: { id, name, topic, owner, admins:[], banned:[], createdAt }
    },
    history: {
      // roomId: [{ user, text, ts, system, clientId }]
    },
    stats: {
      createdAt: now(),
      lastSavedAt: now(),
    }
  };
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const db = defaultDb();
    // seed rooms
    for (const r of DEFAULT_PUBLIC_ROOMS) {
      db.rooms[r.id] = { ...r, createdAt: now() };
      db.history[r.id] = [
        { user: "system", text: `Welcome to ${r.name}.`, ts: now(), system: true },
      ];
    }
    atomicWriteJson(DB_FILE, db);
    return db;
  }
  const raw = fs.readFileSync(DB_FILE, "utf8");
  const db = safeJsonParse(raw, defaultDb());
  // ensure rooms exist
  db.rooms = db.rooms || {};
  db.history = db.history || {};
  for (const r of DEFAULT_PUBLIC_ROOMS) {
    if (!db.rooms[r.id]) {
      db.rooms[r.id] = { ...r, createdAt: now() };
      db.history[r.id] = db.history[r.id] || [
        { user: "system", text: `Welcome to ${r.name}.`, ts: now(), system: true },
      ];
    }
    if (!db.history[r.id]) db.history[r.id] = [];
  }
  db.users = db.users || {};
  db.tokens = db.tokens || {};
  db.stats = db.stats || { createdAt: now(), lastSavedAt: now() };
  return db;
}

let DB = loadDb();
let saveTimer = null;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    DB.stats.lastSavedAt = now();
    atomicWriteJson(DB_FILE, DB);
  }, 150);
}

function publicRoomsView() {
  const out = Object.values(DB.rooms)
    .map(r => ({
      id: r.id,
      name: r.name,
      topic: r.topic || "",
      owner: r.owner,
      admins: Array.isArray(r.admins) ? r.admins : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function userPublicView(u) {
  if (!u) return null;
  return {
    username: u.username,
    isGuest: !!u.isGuest,
    level: u.level || 1,
  };
}

// -----------------------------
// Token handling (simple HMAC)
// -----------------------------
function newToken(username) {
  const issuedAt = now();
  const ttlMs = 1000 * 60 * 60 * 24 * 7; // 7 days
  const expiresAt = issuedAt + ttlMs;
  const rnd = crypto.randomBytes(24).toString("hex");
  const payload = `${username}.${issuedAt}.${expiresAt}.${rnd}`;
  const sig = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
  const token = `${payload}.${sig}`;

  const tokenHash = sha256Hex(token);
  DB.tokens[tokenHash] = { username, createdAt: issuedAt, expiresAt };
  scheduleSave();

  return token;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return { ok: false, error: "Missing token" };
  const parts = token.split(".");
  if (parts.length < 5) return { ok: false, error: "Invalid token" };

  const sig = parts[parts.length - 1];
  const payload = parts.slice(0, parts.length - 1).join(".");
  const expected = crypto.createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
  if (!timingSafeEq(sig, expected)) return { ok: false, error: "Invalid token signature" };

  const username = parts[0];
  const issuedAt = Number(parts[1]);
  const expiresAt = Number(parts[2]);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return { ok: false, error: "Invalid token times" };
  if (now() > expiresAt) return { ok: false, error: "Token expired" };

  const tokenHash = sha256Hex(token);
  const row = DB.tokens[tokenHash];
  if (!row || row.username !== username) return { ok: false, error: "Token not recognized" };
  if (now() > row.expiresAt) return { ok: false, error: "Token expired" };

  const user = DB.users[username];
  if (!user) return { ok: false, error: "User not found" };

  return { ok: true, username, user };
}

function revokeToken(token) {
  if (!token) return;
  const tokenHash = sha256Hex(token);
  if (DB.tokens[tokenHash]) {
    delete DB.tokens[tokenHash];
    scheduleSave();
  }
}

// periodic cleanup
setInterval(() => {
  const t = now();
  let changed = false;
  for (const [k, v] of Object.entries(DB.tokens)) {
    if (!v || !v.expiresAt || t > v.expiresAt) {
      delete DB.tokens[k];
      changed = true;
    }
  }
  if (changed) scheduleSave();
}, 1000 * 60 * 10);

// -----------------------------
// Auth: create/login/guest
// -----------------------------
function createUser({ username, password, isGuest }) {
  username = normalizeUsername(username);
  if (!isValidUsername(username)) {
    return { ok: false, error: `Username must be ${USERNAME_MIN}-${USERNAME_MAX} chars and use letters/numbers/._-` };
  }
  if (DB.users[username] && !DB.users[username].isGuest) {
    // existing non-guest user
    if (isGuest) return { ok: false, error: "Username already taken" };
  }

  const createdAt = now();

  if (isGuest) {
    // guests can overwrite previous guest name if collision (rare); add suffix if occupied by real user
    if (DB.users[username] && !DB.users[username].isGuest) {
      username = username + "_" + crypto.randomBytes(2).toString("hex");
    }
    DB.users[username] = {
      username,
      passSalt: "",
      passHash: "",
      createdAt,
      isGuest: true,
      level: 1
    };
    scheduleSave();
    return { ok: true, user: DB.users[username] };
  }

  if (typeof password !== "string" || password.trim().length < 4) {
    return { ok: false, error: "Password must be at least 4 characters" };
  }

  const passSalt = crypto.randomBytes(16).toString("hex");
  const passHash = pbkdf2Hash(password, passSalt);

  DB.users[username] = {
    username,
    passSalt,
    passHash,
    createdAt,
    isGuest: false,
    level: 1
  };
  scheduleSave();
  return { ok: true, user: DB.users[username] };
}

function loginUser({ username, password }) {
  username = normalizeUsername(username);
  const user = DB.users[username];
  if (!user) return { ok: false, error: "Invalid username or password" };
  if (user.isGuest) return { ok: false, error: "This username is a guest account. Use a different name." };

  const passHash = pbkdf2Hash(password, user.passSalt);
  if (!timingSafeEq(passHash, user.passHash)) return { ok: false, error: "Invalid username or password" };
  return { ok: true, user };
}

function ensureGlobalOwnerIsSystem() {
  const g = DB.rooms["global"];
  if (g && !g.owner) g.owner = "system";
}
ensureGlobalOwnerIsSystem();

// -----------------------------
// Express app
// -----------------------------
const app = express();
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: false, // keep simple for this project
}));
app.use(compression());
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

// basic rate limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use("/api/auth", authLimiter);

// serve frontend
app.use("/", express.static(PUBLIC_DIR, { extensions: ["html"] }));

function getAuthToken(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice("Bearer ".length).trim();
  if (req.cookies && req.cookies.token) return String(req.cookies.token);
  return "";
}

function requireAuth(req, res, next) {
  const token = getAuthToken(req);
  const v = verifyToken(token);
  if (!v.ok) return res.status(401).json({ ok: false, error: v.error || "Unauthorized" });
  req.user = v.user;
  req.username = v.username;
  req.token = token;
  next();
}

// status
app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    time: now(),
    publicRooms: Object.keys(DB.rooms).length,
    version: "tonkotsu-server-1",
  });
});

// me + rooms
app.get("/api/me", requireAuth, (req, res) => {
  res.json({
    ok: true,
    me: userPublicView(req.user),
    publicRooms: publicRoomsView(),
  });
});

// login/create account
app.post("/api/auth/login", (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password ?? "");

  if (!isValidUsername(username)) {
    return res.status(400).json({ ok: false, error: `Username must be ${USERNAME_MIN}-${USERNAME_MAX} chars and use letters/numbers/._-` });
  }

  if (!DB.users[username]) {
    const created = createUser({ username, password, isGuest: false });
    if (!created.ok) return res.status(400).json(created);
  }

  const login = loginUser({ username, password });
  if (!login.ok) return res.status(401).json(login);

  const token = newToken(username);
  res.cookie("token", token, { httpOnly: false, sameSite: "lax" }); // keep frontend simple
  res.json({ ok: true, token, me: userPublicView(login.user) });
});

// guest
app.post("/api/auth/guest", (req, res) => {
  let username = normalizeUsername(req.body?.username);
  if (!username) {
    username = "guest_" + crypto.randomBytes(3).toString("hex");
  }
  if (!isValidUsername(username)) {
    username = "guest_" + crypto.randomBytes(3).toString("hex");
  }

  // avoid collision with real users
  if (DB.users[username] && !DB.users[username].isGuest) {
    username = username + "_" + crypto.randomBytes(2).toString("hex");
  }

  if (!DB.users[username]) {
    const created = createUser({ username, password: "", isGuest: true });
    if (!created.ok) return res.status(400).json(created);
  }

  const token = newToken(username);
  res.cookie("token", token, { httpOnly: false, sameSite: "lax" });
  res.json({ ok: true, token, me: userPublicView(DB.users[username]) });
});

// logout
app.post("/api/auth/logout", requireAuth, (req, res) => {
  revokeToken(req.token);
  res.cookie("token", "", { httpOnly: false, sameSite: "lax", expires: new Date(0) });
  res.json({ ok: true });
});

// -----------------------------
// Socket.IO
// -----------------------------
const io = new Server(server, {
  cors: { origin: true, credentials: true },
  maxHttpBufferSize: 1e6,
});

const presence = {
  online: 0,
  // socketId -> username
  sockToUser: new Map(),
  // username -> count
  userCounts: new Map(),
};

function presenceInc(username) {
  presence.online += 1;
  presence.userCounts.set(username, (presence.userCounts.get(username) || 0) + 1);
}
function presenceDec(username) {
  presence.online = Math.max(0, presence.online - 1);
  const n = (presence.userCounts.get(username) || 0) - 1;
  if (n <= 0) presence.userCounts.delete(username);
  else presence.userCounts.set(username, n);
}
function broadcastPresence() {
  io.emit("presence", { online: presence.online });
}

function getRoom(roomKey) {
  if (!roomKey) return null;
  const key = String(roomKey);
  if (DB.rooms[key]) return DB.rooms[key];
  // also allow by name
  const byName = Object.values(DB.rooms).find(r => String(r.name).toLowerCase() === key.toLowerCase());
  return byName || null;
}

function isBanned(room, username) {
  if (!room) return false;
  const banned = Array.isArray(room.banned) ? room.banned : [];
  return banned.includes(username);
}

function roleFor(room, username) {
  if (!room || !username) return "member";
  if (room.owner === username) return "owner";
  const admins = Array.isArray(room.admins) ? room.admins : [];
  if (admins.includes(username)) return "admin";
  return "member";
}

function canAdmin(room, username) {
  const role = roleFor(room, username);
  return role === "owner" || role === "admin";
}

function pushHistory(roomId, msg) {
  DB.history[roomId] = DB.history[roomId] || [];
  DB.history[roomId].push(msg);
  if (DB.history[roomId].length > MAX_HISTORY) {
    DB.history[roomId] = DB.history[roomId].slice(DB.history[roomId].length - MAX_HISTORY);
  }
  scheduleSave();
}

function systemMsg(roomId, text) {
  const m = { user: "system", text: clampStr(text, MAX_TEXT), ts: now(), system: true };
  pushHistory(roomId, m);
  io.to("room:" + roomId).emit("room:msg", { room: roomId, msg: m });
}

io.on("connection", (socket) => {
  // not authenticated until "auth" ack
  let authed = false;
  let username = "";
  let joinedRooms = new Set();

  socket.on("auth", (payload, cb) => {
    try {
      const token = String(payload?.token || "");
      const v = verifyToken(token);
      if (!v.ok) {
        cb && cb({ ok: false, error: v.error || "Unauthorized" });
        return;
      }
      authed = true;
      username = v.username;

      presence.sockToUser.set(socket.id, username);
      presenceInc(username);
      broadcastPresence();

      cb && cb({ ok: true, me: userPublicView(v.user) });
    } catch (e) {
      cb && cb({ ok: false, error: e.message || "Auth error" });
    }
  });

  socket.on("room:join", (payload, cb) => {
    if (!authed) return cb && cb({ ok: false, error: "Not authenticated" });

    const key = String(payload?.room || "global");
    const room = getRoom(key);
    if (!room) return cb && cb({ ok: false, error: "Room not found" });

    if (isBanned(room, username)) return cb && cb({ ok: false, error: "You are banned from this room" });

    const roomId = room.id;
    const channel = "room:" + roomId;

    // leave other joined rooms (single-room view, keeps it simple)
    for (const r of joinedRooms) {
      try { socket.leave(r); } catch {}
    }
    joinedRooms = new Set([channel]);

    socket.join(channel);

    // send history
    const hist = DB.history[roomId] || [];
    cb && cb({ ok: true, history: hist });

    // optional room hint
    socket.emit("server:toast", { message: `Joined ${room.name}` });
  });

  socket.on("room:send", (payload, cb) => {
    if (!authed) return cb && cb({ ok: false, error: "Not authenticated" });

    const key = String(payload?.room || "global");
    const room = getRoom(key);
    if (!room) return cb && cb({ ok: false, error: "Room not found" });
    if (isBanned(room, username)) return cb && cb({ ok: false, error: "You are banned from this room" });

    const roomId = room.id;
    const channel = "room:" + roomId;
    if (!joinedRooms.has(channel)) {
      return cb && cb({ ok: false, error: "Join the room first" });
    }

    const text = clampStr(String(payload?.text || ""), MAX_TEXT).trim();
    if (!text) return cb && cb({ ok: false, error: "Empty message" });
    if (text.length > MAX_TEXT) return cb && cb({ ok: false, error: "Message too long" });

    const clientId = clampStr(String(payload?.clientId || ""), 80);

    // basic leveling
    const u = DB.users[username];
    if (u && !u.isGuest) {
      u.level = Math.min(999, (u.level || 1) + (text.length >= 30 ? 1 : 0));
      scheduleSave();
    }

    const msg = {
      user: username,
      text,
      ts: now(),
      system: false,
      clientId: clientId || undefined,
    };
    pushHistory(roomId, msg);

    io.to(channel).emit("room:msg", { room: roomId, msg });
    cb && cb({ ok: true });
  });

  // ---- Admin actions ----
  socket.on("room:promote", (payload, cb) => {
    if (!authed) return cb && cb({ ok: false, error: "Not authenticated" });
    const room = getRoom(payload?.room || "global");
    if (!room) return cb && cb({ ok: false, error: "Room not found" });
    if (!canAdmin(room, username)) return cb && cb({ ok: false, error: "No permission" });

    const target = normalizeUsername(payload?.username);
    if (!target || !DB.users[target]) return cb && cb({ ok: false, error: "Target not found" });
    if (room.owner === target) return cb && cb({ ok: false, error: "Target is owner" });

    room.admins = Array.isArray(room.admins) ? room.admins : [];
    if (!room.admins.includes(target)) room.admins.push(target);
    scheduleSave();

    systemMsg(room.id, `${target} was promoted by ${username}.`);
    cb && cb({ ok: true });
  });

  socket.on("room:demote", (payload, cb) => {
    if (!authed) return cb && cb({ ok: false, error: "Not authenticated" });
    const room = getRoom(payload?.room || "global");
    if (!room) return cb && cb({ ok: false, error: "Room not found" });

    // only owner can demote admins (admins cannot demote others)
    const role = roleFor(room, username);
    if (role !== "owner") return cb && cb({ ok: false, error: "Owner only" });

    const target = normalizeUsername(payload?.username);
    if (!target || !DB.users[target]) return cb && cb({ ok: false, error: "Target not found" });
    if (room.owner === target) return cb && cb({ ok: false, error: "Cannot demote owner" });

    room.admins = Array.isArray(room.admins) ? room.admins : [];
    room.admins = room.admins.filter(u => u !== target);
    scheduleSave();

    systemMsg(room.id, `${target} was demoted by ${username}.`);
    cb && cb({ ok: true });
  });

  socket.on("room:ban", (payload, cb) => {
    if (!authed) return cb && cb({ ok: false, error: "Not authenticated" });
    const room = getRoom(payload?.room || "global");
    if (!room) return cb && cb({ ok: false, error: "Room not found" });
    if (!canAdmin(room, username)) return cb && cb({ ok: false, error: "No permission" });

    const target = normalizeUsername(payload?.username);
    if (!target || !DB.users[target]) return cb && cb({ ok: false, error: "Target not found" });
    if (room.owner === target) return cb && cb({ ok: false, error: "Cannot ban owner" });

    room.banned = Array.isArray(room.banned) ? room.banned : [];
    if (!room.banned.includes(target)) room.banned.push(target);

    // if banned user was admin, remove admin (owner decision)
    room.admins = Array.isArray(room.admins) ? room.admins : [];
    room.admins = room.admins.filter(u => u !== target);

    scheduleSave();

    systemMsg(room.id, `${target} was banned by ${username}.`);
    cb && cb({ ok: true });

    // kick any sockets of that user out of the room channel
    for (const [sid, u] of presence.sockToUser.entries()) {
      if (u === target) {
        const s = io.sockets.sockets.get(sid);
        if (s) {
          try { s.leave("room:" + room.id); } catch {}
          try { s.emit("server:toast", { message: `You were banned from ${room.name}` }); } catch {}
        }
      }
    }
  });

  socket.on("room:unban", (payload, cb) => {
    if (!authed) return cb && cb({ ok: false, error: "Not authenticated" });
    const room = getRoom(payload?.room || "global");
    if (!room) return cb && cb({ ok: false, error: "Room not found" });
    if (!canAdmin(room, username)) return cb && cb({ ok: false, error: "No permission" });

    const target = normalizeUsername(payload?.username);
    room.banned = Array.isArray(room.banned) ? room.banned : [];
    room.banned = room.banned.filter(u => u !== target);
    scheduleSave();

    systemMsg(room.id, `${target} was unbanned by ${username}.`);
    cb && cb({ ok: true });
  });

  socket.on("room:topic", (payload, cb) => {
    if (!authed) return cb && cb({ ok: false, error: "Not authenticated" });
    const room = getRoom(payload?.room || "global");
    if (!room) return cb && cb({ ok: false, error: "Room not found" });
    if (!canAdmin(room, username)) return cb && cb({ ok: false, error: "No permission" });

    const topic = clampStr(String(payload?.topic ?? ""), TOPIC_MAX).trim();
    room.topic = topic;
    scheduleSave();

    systemMsg(room.id, `Topic updated by ${username}: ${topic || "—"}`);
    cb && cb({ ok: true });
  });

  socket.on("disconnect", () => {
    if (authed) {
      presence.sockToUser.delete(socket.id);
      presenceDec(username);
      broadcastPresence();
    }
  });
});

// -----------------------------
// Startup
// -----------------------------
server.listen(PORT, () => {
  console.log(`[tonkotsu] server running on http://localhost:${PORT}`);
  console.log(`[tonkotsu] serving public from: ${PUBLIC_DIR}`);
  console.log(`[tonkotsu] data dir: ${DATA_DIR}`);
});

