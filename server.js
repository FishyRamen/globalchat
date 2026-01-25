// server/server.js
// tonkotsu.online backend: Express + Socket.IO
// Features implemented:
// - Login/Create (first login creates account) + Guest sessions
// - Token auth for REST + Socket.IO ("auth" event)
// - Public group chats (rooms), seed defaults
// - Owner/admin permissions: kick/ban, set topic, promote/demote
// - Message history per room
// - Simple JSON persistence (no external DB required)

"use strict";

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const http = require("http");

const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");

// ===============================
// Config
// ===============================
const PORT = process.env.PORT || 3000;
const ORIGIN = process.env.ORIGIN || ""; // set if you want strict origin checks
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const MAX_MSG_LEN = 1200;
const ROOM_HISTORY_LIMIT = 250;
const USERNAME_MIN = 4;
const USERNAME_MAX = 20;

// ===============================
// Helpers
// ===============================
function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function now() {
  return Date.now();
}

function isoNow() {
  return new Date().toISOString();
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}_${Date.now().toString(36)}`;
}

function normalizeUsername(u) {
  const s = String(u || "").trim();
  return s.replace(/[^\w-]/g, "").slice(0, USERNAME_MAX);
}

function usernameOk(u) {
  if (!u) return false;
  if (u.length < USERNAME_MIN || u.length > USERNAME_MAX) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(u)) return false;
  return true;
}

function hashPassword(pw, salt) {
  // PBKDF2 (good enough for a lightweight JSON DB demo)
  const iterations = 120000;
  const keylen = 32;
  const digest = "sha256";
  const dk = crypto.pbkdf2Sync(pw, salt, iterations, keylen, digest);
  return dk.toString("hex");
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function makeToken() {
  return crypto.randomBytes(32).toString("hex");
}

// ===============================
// DB
// ===============================
function defaultDb() {
  return {
    version: 1,
    users: {
      // username -> { username, salt, passHash, createdAt, level, tag, isGuest, bans:{roomId:true}, createdRooms:[] }
    },
    sessions: {
      // token -> { username, expiresAt }
    },
    rooms: {
      // roomId -> { id, name, isPublic, createdAt, owner, admins:[], topic, bannedUsers:[], messages:[] }
    },
  };
}

class Db {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = readJson(filePath, defaultDb());
    this._dirty = false;
    this._saveTimer = null;

    ensureDir(path.dirname(filePath));
    this.seedDefaultRooms();
    this.saveSoon();
  }

  saveSoon() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (!this._dirty) return;
      this._dirty = false;
      writeJsonAtomic(this.filePath, this.data);
    }, 250);
  }

  seedDefaultRooms() {
    // Create a few public rooms if none exist.
    const rooms = Object.values(this.data.rooms || {});
    if (rooms.length > 0) return;

    const seed = [
      { name: "Global", topic: "Public room • Be respectful" },
      { name: "Gaming", topic: "Find teammates, share clips" },
      { name: "Music", topic: "Drop songs, production talk" },
      { name: "School", topic: "Homework help and study" },
    ];

    for (const r of seed) {
      const id = randomId("room");
      this.data.rooms[id] = {
        id,
        name: r.name,
        isPublic: true,
        createdAt: isoNow(),
        owner: "system",
        admins: [],
        topic: r.topic,
        bannedUsers: [],
        messages: [
          {
            id: randomId("msg"),
            user: "System",
            ts: isoNow(),
            text: `Welcome to ${r.name}.`,
            system: true,
          },
        ],
      };
    }
  }

  getRoomByName(name) {
    const n = String(name || "").trim().toLowerCase();
    for (const room of Object.values(this.data.rooms)) {
      if (room.name.toLowerCase() === n) return room;
    }
    return null;
  }

  getRoom(roomIdOrName) {
    const key = String(roomIdOrName || "");
    if (this.data.rooms[key]) return this.data.rooms[key];
    // allow join by reserved "global" alias used by your front-end
    if (key === "global") {
      const r = this.getRoomByName("Global");
      return r || null;
    }
    if (key === "inbox") return null; // inbox/DMs not implemented as rooms in this server
    // fallback by name
    return this.getRoomByName(key);
  }

  listPublicRooms() {
    return Object.values(this.data.rooms)
      .filter((r) => r.isPublic)
      .map((r) => ({
        id: r.id,
        name: r.name,
        topic: r.topic || "",
        owner: r.owner,
        admins: r.admins || [],
        createdAt: r.createdAt,
      }));
  }

  upsertUser(user) {
    this.data.users[user.username] = user;
    this.saveSoon();
  }

  getUser(username) {
    return this.data.users[String(username || "")] || null;
  }

  createUser({ username, password, isGuest = false }) {
    const u = normalizeUsername(username);
    if (!usernameOk(u)) throw new Error("Invalid username.");

    const existing = this.getUser(u);
    if (existing) throw new Error("User already exists.");

    const salt = crypto.randomBytes(16).toString("hex");
    const passHash = isGuest ? "" : hashPassword(password, salt);

    const user = {
      username: u,
      salt,
      passHash,
      createdAt: isoNow(),
      level: 1,
      tag: isGuest ? "GUEST" : "",
      isGuest: !!isGuest,
      bans: {}, // roomId -> true
      createdRooms: [],
    };

    this.upsertUser(user);
    return user;
  }

  verifyUserPassword(username, password) {
    const user = this.getUser(username);
    if (!user) return { ok: false, error: "Invalid username or password." };
    if (user.isGuest) return { ok: false, error: "Guest account cannot be used with password." };
    const candidate = hashPassword(password, user.salt);
    if (!timingSafeEq(candidate, user.passHash)) return { ok: false, error: "Invalid username or password." };
    return { ok: true, user };
  }

  createSession(username) {
    const token = makeToken();
    const expiresAt = now() + TOKEN_TTL_MS;
    this.data.sessions[token] = { username, expiresAt };
    this.saveSoon();
    return token;
  }

  getSession(token) {
    const s = this.data.sessions[String(token || "")];
    if (!s) return null;
    if (now() > s.expiresAt) {
      delete this.data.sessions[String(token || "")];
      this.saveSoon();
      return null;
    }
    return s;
  }

  revokeSession(token) {
    if (this.data.sessions[String(token || "")]) {
      delete this.data.sessions[String(token || "")];
      this.saveSoon();
    }
  }

  addMessage(roomId, msg) {
    const room = this.data.rooms[roomId];
    if (!room) return;
    room.messages = room.messages || [];
    room.messages.push(msg);
    if (room.messages.length > ROOM_HISTORY_LIMIT) {
      room.messages.splice(0, room.messages.length - ROOM_HISTORY_LIMIT);
    }
    this.saveSoon();
  }

  isBanned(room, username) {
    if (!room) return false;
    const u = String(username || "");
    const banned = new Set(room.bannedUsers || []);
    return banned.has(u);
  }

  roleFor(room, username) {
    const u = String(username || "");
    if (u === room.owner) return "owner";
    if ((room.admins || []).includes(u)) return "admin";
    return "member";
  }

  requireOwnerOrAdmin(room, username) {
    const role = this.roleFor(room, username);
    if (role !== "owner" && role !== "admin") {
      throw new Error("Insufficient permissions.");
    }
    return role;
  }
}

const db = new Db(DB_PATH);

// ===============================
// Express app
// ===============================
const app = express();
app.use(cors({ origin: ORIGIN || true, credentials: true }));
app.use(express.json({ limit: "256kb" }));

// Serve your static client (assuming /public folder one level up from /server)
const publicDir = path.join(__dirname, "..", "public");
app.use(express.static(publicDir, { extensions: ["html"] }));

// -------------------------------
// Auth middleware (REST)
// -------------------------------
function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1] : "";
}

function requireAuth(req, res, next) {
  const token = getBearerToken(req);
  if (!token) return res.status(401).json({ ok: false, error: "Missing token." });

  const sess = db.getSession(token);
  if (!sess) return res.status(401).json({ ok: false, error: "Invalid or expired token." });

  const user = db.getUser(sess.username);
  if (!user) return res.status(401).json({ ok: false, error: "User not found." });

  req.auth = { token, user };
  next();
}

// -------------------------------
// Status
// -------------------------------
app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    message: "tonkotsu server ok",
    time: isoNow(),
    publicRooms: db.listPublicRooms().length,
  });
});

// -------------------------------
// Auth routes
// -------------------------------
app.post("/api/auth/login", (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || "");

  if (!usernameOk(username)) return res.status(400).json({ ok: false, error: "Invalid username." });
  if (password.length < 4) return res.status(400).json({ ok: false, error: "Password too short." });

  const existing = db.getUser(username);
  let user;

  if (!existing) {
    // First login creates account
    user = db.createUser({ username, password, isGuest: false });
  } else {
    const v = db.verifyUserPassword(username, password);
    if (!v.ok) return res.status(401).json({ ok: false, error: v.error });
    user = v.user;
  }

  const token = db.createSession(user.username);
  res.json({
    ok: true,
    token,
    me: {
      username: user.username,
      level: user.level || 1,
      tag: user.tag || "",
      isGuest: !!user.isGuest,
    },
  });
});

app.post("/api/auth/guest", (req, res) => {
  let username = normalizeUsername(req.body?.username || "");
  if (!usernameOk(username)) {
    username = `guest${Math.floor(Math.random() * 9000 + 1000)}`;
  }

  let user = db.getUser(username);
  if (!user) {
    user = db.createUser({ username, password: "", isGuest: true });
  } else {
    // If the name exists and isn't guest, pick another
    if (!user.isGuest) {
      username = `guest${Math.floor(Math.random() * 9000 + 1000)}`;
      user = db.getUser(username) || db.createUser({ username, password: "", isGuest: true });
    }
  }

  const token = db.createSession(user.username);
  res.json({
    ok: true,
    token,
    me: {
      username: user.username,
      level: user.level || 1,
      tag: user.tag || "GUEST",
      isGuest: true,
    },
  });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  db.revokeSession(req.auth.token);
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, (req, res) => {
  const u = req.auth.user;
  res.json({
    ok: true,
    me: {
      username: u.username,
      level: u.level || 1,
      tag: u.tag || "",
      isGuest: !!u.isGuest,
    },
    publicRooms: db.listPublicRooms(),
  });
});

// ===============================
// HTTP + Socket.IO
// ===============================
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ORIGIN || true,
    methods: ["GET", "POST"],
  },
});

// Simple online count
let onlineCount = 0;
function broadcastPresence() {
  io.emit("presence", { online: onlineCount });
}

// Socket auth: store on socket.data
async function socketAuth(token) {
  const sess = db.getSession(token);
  if (!sess) return { ok: false, error: "Invalid or expired token." };

  const user = db.getUser(sess.username);
  if (!user) return { ok: false, error: "User not found." };

  return {
    ok: true,
    user: {
      username: user.username,
      level: user.level || 1,
      tag: user.tag || "",
      isGuest: !!user.isGuest,
    },
  };
}

// Rooms: map socket.id -> joined room ids
const joinedRooms = new Map(); // socket.id -> Set(roomId)

// Helpers for permissioned actions
function ensureAuthed(socket) {
  const me = socket.data?.me;
  if (!me?.username) throw new Error("Not authenticated.");
  return me;
}

function ensureRoom(roomKey) {
  const r = db.getRoom(roomKey);
  if (!r) throw new Error("Room not found.");
  if (!r.isPublic) throw new Error("Room is not public.");
  return r;
}

function ensureNotBanned(room, username) {
  if (db.isBanned(room, username)) throw new Error("You are banned from this room.");
}

function coerceText(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("Empty message.");
  if (t.length > MAX_MSG_LEN) throw new Error("Message too long.");
  return t;
}

io.on("connection", (socket) => {
  onlineCount += 1;
  broadcastPresence();

  socket.data.me = null;

  socket.on("disconnect", () => {
    onlineCount = Math.max(0, onlineCount - 1);
    broadcastPresence();
    joinedRooms.delete(socket.id);
  });

  // Client must call: socket.emit("auth",{token}, ack)
  socket.on("auth", async (payload, ack) => {
    try {
      const token = String(payload?.token || "");
      const r = await socketAuth(token);
      if (!r.ok) return ack && ack({ ok: false, error: r.error });

      socket.data.me = r.user;
      ack && ack({ ok: true, me: r.user });

      socket.emit("server:toast", { message: `Signed in as ${r.user.username}` });
    } catch (e) {
      ack && ack({ ok: false, error: e.message || "Auth failed." });
    }
  });

  // Join a room: socket.emit("room:join",{room}, ack)
  socket.on("room:join", (payload, ack) => {
    try {
      const me = ensureAuthed(socket);
      const key = String(payload?.room || "global");
      const room = ensureRoom(key);

      ensureNotBanned(room, me.username);

      // join underlying socket.io room by room.id
      socket.join(room.id);

      let set = joinedRooms.get(socket.id);
      if (!set) {
        set = new Set();
        joinedRooms.set(socket.id, set);
      }
      set.add(room.id);

      // send history
      const history = (room.messages || []).slice(-ROOM_HISTORY_LIMIT);

      ack && ack({ ok: true, history });

      // also emit a history event (optional)
      socket.emit("room:history", { room: key, messages: history });

      // announce join (system msg)
      const joinMsg = {
        id: randomId("msg"),
        user: "System",
        ts: isoNow(),
        text: `${me.username} joined ${room.name}.`,
        system: true,
      };
      db.addMessage(room.id, joinMsg);
      io.to(room.id).emit("room:msg", { room: key, msg: joinMsg });
    } catch (e) {
      ack && ack({ ok: false, error: e.message || "Join failed." });
    }
  });

  // Send: socket.emit("room:send",{room,text,clientId}, ack)
  socket.on("room:send", (payload, ack) => {
    try {
      const me = ensureAuthed(socket);
      const key = String(payload?.room || "global");
      const room = ensureRoom(key);

      ensureNotBanned(room, me.username);

      const text = coerceText(payload?.text);
      const clientId = String(payload?.clientId || "");

      const msg = {
        id: randomId("msg"),
        clientId: clientId || null,
        user: me.username,
        ts: isoNow(),
        text,
      };

      db.addMessage(room.id, msg);

      // Broadcast to room
      io.to(room.id).emit("room:msg", { room: key, msg });

      ack && ack({ ok: true, msg });
    } catch (e) {
      ack && ack({ ok: false, error: e.message || "Send failed." });
    }
  });

  // ---------------------------
  // Owner/Admin commands (hooks for “group chat owner permissions”)
  // Client can emit these later from UI; server side is ready.
  // ---------------------------

  // Promote: socket.emit("room:promote",{room, username}, ack)
  socket.on("room:promote", (payload, ack) => {
    try {
      const me = ensureAuthed(socket);
      const key = String(payload?.room || "global");
      const room = ensureRoom(key);

      // only owner can promote
      if (db.roleFor(room, me.username) !== "owner") throw new Error("Only owner can promote.");

      const target = normalizeUsername(payload?.username || "");
      if (!usernameOk(target)) throw new Error("Invalid target username.");
      if (target === room.owner) throw new Error("Owner is already top role.");

      room.admins = room.admins || [];
      if (!room.admins.includes(target)) room.admins.push(target);

      db.saveSoon();

      const sys = {
        id: randomId("msg"),
        user: "System",
        ts: isoNow(),
        text: `${target} is now an admin.`,
        system: true,
      };
      db.addMessage(room.id, sys);
      io.to(room.id).emit("room:msg", { room: key, msg: sys });

      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message || "Promote failed." });
    }
  });

  // Demote: socket.emit("room:demote",{room, username}, ack)
  socket.on("room:demote", (payload, ack) => {
    try {
      const me = ensureAuthed(socket);
      const key = String(payload?.room || "global");
      const room = ensureRoom(key);

      if (db.roleFor(room, me.username) !== "owner") throw new Error("Only owner can demote.");

      const target = normalizeUsername(payload?.username || "");
      room.admins = (room.admins || []).filter((u) => u !== target);

      db.saveSoon();

      const sys = {
        id: randomId("msg"),
        user: "System",
        ts: isoNow(),
        text: `${target} is no longer an admin.`,
        system: true,
      };
      db.addMessage(room.id, sys);
      io.to(room.id).emit("room:msg", { room: key, msg: sys });

      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message || "Demote failed." });
    }
  });

  // Ban: socket.emit("room:ban",{room, username}, ack)
  socket.on("room:ban", (payload, ack) => {
    try {
      const me = ensureAuthed(socket);
      const key = String(payload?.room || "global");
      const room = ensureRoom(key);

      db.requireOwnerOrAdmin(room, me.username);

      const target = normalizeUsername(payload?.username || "");
      if (!usernameOk(target)) throw new Error("Invalid target username.");
      if (target === room.owner) throw new Error("Cannot ban the owner.");

      room.bannedUsers = room.bannedUsers || [];
      if (!room.bannedUsers.includes(target)) room.bannedUsers.push(target);

      db.saveSoon();

      const sys = {
        id: randomId("msg"),
        user: "System",
        ts: isoNow(),
        text: `${target} was banned by ${me.username}.`,
        system: true,
      };
      db.addMessage(room.id, sys);
      io.to(room.id).emit("room:msg", { room: key, msg: sys });

      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message || "Ban failed." });
    }
  });

  // Unban: socket.emit("room:unban",{room, username}, ack)
  socket.on("room:unban", (payload, ack) => {
    try {
      const me = ensureAuthed(socket);
      const key = String(payload?.room || "global");
      const room = ensureRoom(key);

      db.requireOwnerOrAdmin(room, me.username);

      const target = normalizeUsername(payload?.username || "");
      room.bannedUsers = (room.bannedUsers || []).filter((u) => u !== target);

      db.saveSoon();

      const sys = {
        id: randomId("msg"),
        user: "System",
        ts: isoNow(),
        text: `${target} was unbanned by ${me.username}.`,
        system: true,
      };
      db.addMessage(room.id, sys);
      io.to(room.id).emit("room:msg", { room: key, msg: sys });

      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message || "Unban failed." });
    }
  });

  // Topic: socket.emit("room:topic",{room, topic}, ack)
  socket.on("room:topic", (payload, ack) => {
    try {
      const me = ensureAuthed(socket);
      const key = String(payload?.room || "global");
      const room = ensureRoom(key);

      db.requireOwnerOrAdmin(room, me.username);

      const topic = String(payload?.topic || "").trim().slice(0, 140);
      room.topic = topic;

      db.saveSoon();

      const sys = {
        id: randomId("msg"),
        user: "System",
        ts: isoNow(),
        text: `Topic updated by ${me.username}: ${topic || "(no topic)"}`,
        system: true,
      };
      db.addMessage(room.id, sys);
      io.to(room.id).emit("room:msg", { room: key, msg: sys });

      ack && ack({ ok: true });
    } catch (e) {
      ack && ack({ ok: false, error: e.message || "Topic update failed." });
    }
  });
});

// ===============================
// Start server
// ===============================
server.listen(PORT, () => {
  console.log(`tonkotsu server listening on http://localhost:${PORT}`);
  console.log(`Serving public dir: ${publicDir}`);
  console.log(`DB path: ${DB_PATH}`);
});


