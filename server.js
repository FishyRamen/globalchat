"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { nanoid } = require("nanoid");

const http = require("http");
const { Server } = require("socket.io");

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT || 3000);
const NODE_ENV = process.env.NODE_ENV || "development";
const CLIENT_URL = process.env.CLIENT_URL || "*";
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_SHARED_SECRET = process.env.ADMIN_SHARED_SECRET;

if (!JWT_SECRET) {
  console.error("Missing JWT_SECRET in env.");
  process.exit(1);
}
if (!ADMIN_SHARED_SECRET) {
  console.error("Missing ADMIN_SHARED_SECRET in env.");
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MSG_FILE = path.join(DATA_DIR, "messages.json");
const GROUPS_FILE = path.join(DATA_DIR, "groups.json");
const REPORTS_FILE = path.join(DATA_DIR, "reports.json");
const BANS_FILE = path.join(DATA_DIR, "bans.json");

// -------------------- UTIL --------------------
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}
ensureDataDir();

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}
function now() {
  return Date.now();
}
function safeStr(v, max = 5000) {
  return String(v ?? "").slice(0, max);
}
function lower(v) {
  return safeStr(v, 200).trim().toLowerCase();
}
function pickColor(seed) {
  // stable-ish color from username
  const h = crypto.createHash("sha256").update(String(seed || "x")).digest("hex");
  const n = parseInt(h.slice(0, 6), 16);
  const hues = [210, 280, 170, 25, 340, 120, 200, 45, 300, 160];
  const hue = hues[n % hues.length];
  return `hsl(${hue} 80% 72%)`;
}
function jwtSign(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "14d" });
}
function jwtVerify(token) {
  return jwt.verify(token, JWT_SECRET);
}
function id() {
  return nanoid(12);
}

// Progressive account-delete ban policy (user request)
function banDurationForStrikes(strikes) {
  // 1st: 3 days, 2nd: 7 days, 3rd+: 365 days
  if (strikes <= 1) return 3 * 24 * 60 * 60 * 1000;
  if (strikes === 2) return 7 * 24 * 60 * 60 * 1000;
  return 365 * 24 * 60 * 60 * 1000;
}

// -------------------- STORAGE --------------------
let users = readJson(USERS_FILE, { byId: {}, byName: {} });
let messages = readJson(MSG_FILE, { global: [], dms: {}, groups: {} });
let groups = readJson(GROUPS_FILE, { byId: {} });
let reports = readJson(REPORTS_FILE, { items: [] });
let bans = readJson(BANS_FILE, { users: {}, ips: {} }); // users[usernameLower]={ strikes, until, permanent }

function persistAll() {
  writeJson(USERS_FILE, users);
  writeJson(MSG_FILE, messages);
  writeJson(GROUPS_FILE, groups);
  writeJson(REPORTS_FILE, reports);
  writeJson(BANS_FILE, bans);
}

function getUserByUsername(username) {
  const key = lower(username);
  const uid = users.byName[key];
  if (!uid) return null;
  return users.byId[uid] || null;
}

function ensureUser(username, passwordPlain = null) {
  const key = lower(username);
  if (!key) return null;
  const existing = getUserByUsername(key);
  if (existing) return existing;

  const u = {
    id: id(),
    username: safeStr(username, 32),
    usernameLower: key,
    passHash: passwordPlain ? bcrypt.hashSync(passwordPlain, 10) : null,
    createdAt: now(),
    lastSeen: now(),
    bio: "",
    color: pickColor(username),
    xp: 0,
    level: 1,
    badges: ["beta"],
    presenceMode: "online",
    friends: [], // array of userIds
  };

  users.byId[u.id] = u;
  users.byName[u.usernameLower] = u.id;
  persistAll();
  return u;
}

// XP/level
function grantXp(user, amount) {
  if (!user) return;
  user.xp = (user.xp || 0) + amount;
  // simple level curve
  const need = (lvl) => 75 + lvl * 35;
  while (user.xp >= need(user.level || 1)) {
    user.xp -= need(user.level || 1);
    user.level = (user.level || 1) + 1;
  }
}

// Bans
function isUserBanned(usernameLower) {
  const entry = bans.users[usernameLower];
  if (!entry) return { banned: false };
  if (entry.permanent) return { banned: true, until: null, permanent: true, strikes: entry.strikes || 0 };
  if (entry.until && now() < entry.until) return { banned: true, until: entry.until, permanent: false, strikes: entry.strikes || 0 };
  return { banned: false };
}
function strikeAndBanUser(usernameLower) {
  const entry = bans.users[usernameLower] || { strikes: 0, until: 0, permanent: false };
  entry.strikes = (entry.strikes || 0) + 1;
  const dur = banDurationForStrikes(entry.strikes);
  entry.until = now() + dur;
  entry.permanent = entry.strikes >= 4 ? true : false;
  bans.users[usernameLower] = entry;
  persistAll();
  return entry;
}
function banIp(ip, ms) {
  bans.ips[ip] = { until: now() + ms };
  persistAll();
}
function isIpBanned(ip) {
  const entry = bans.ips[ip];
  if (!entry) return false;
  if (entry.until && now() < entry.until) return true;
  return false;
}

// Messages
function normalizeScope(scope) {
  if (scope === "global") return "global";
  if (scope === "dm") return "dm";
  if (scope === "group") return "group";
  return null;
}

// -------------------- APP --------------------
const app = express();
app.disable("x-powered-by");

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: CLIENT_URL === "*" ? true : CLIENT_URL, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.use(
  rateLimit({
    windowMs: 60_000,
    limit: 240,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// IP ban middleware
app.use((req, res, next) => {
  const ip =
    (req.headers["x-forwarded-for"] ? String(req.headers["x-forwarded-for"]).split(",")[0].trim() : "") ||
    req.socket.remoteAddress ||
    "unknown";
  if (isIpBanned(ip)) return res.status(403).json({ ok: false, error: "IP temporarily blocked." });
  req._ip = ip;
  next();
});

// serve public
app.use(express.static(path.join(__dirname, "public")));

// Auth middleware
function auth(req, res, next) {
  const hdr = req.headers.authorization || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });
  try {
    const payload = jwtVerify(token);
    const u = users.byId[payload.uid];
    if (!u) return res.status(401).json({ ok: false, error: "Unauthorized" });
    // lastSeen
    u.lastSeen = now();
    next._user = u;
    req.user = u;
    persistAll();
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
}

// bot secret middleware
function botAuth(req, res, next) {
  const s = req.headers["x-tonkotsu-bot-secret"];
  if (!s || s !== ADMIN_SHARED_SECRET) return res.status(401).json({ ok: false, error: "Bot unauthorized" });
  next();
}

// -------------------- AUTH ROUTES --------------------
app.post("/api/auth/login", (req, res) => {
  const username = safeStr(req.body?.username, 32).trim();
  const password = safeStr(req.body?.password, 200);

  if (!username || !password) return res.status(400).json({ ok: false, error: "Missing credentials." });

  const ban = isUserBanned(lower(username));
  if (ban.banned) return res.status(403).json({ ok: false, error: "This account has been erased / temporarily blocked." });

  let u = getUserByUsername(username);
  if (!u) {
    // first login creates account
    u = ensureUser(username, password);
    u.badges = Array.from(new Set([...(u.badges || []), "early access"]));
  } else {
    // verify password if set
    if (!u.passHash) {
      u.passHash = bcrypt.hashSync(password, 10);
    } else {
      const ok = bcrypt.compareSync(password, u.passHash);
      if (!ok) return res.status(401).json({ ok: false, error: "Invalid username/password." });
    }
  }

  const token = jwtSign({ uid: u.id });
  return res.json({ ok: true, token, user: publicUser(u) });
});

app.post("/api/auth/guest", (req, res) => {
  const username = `guest_${Math.random().toString(16).slice(2, 8)}`;
  const u = ensureUser(username, null);
  u.badges = Array.from(new Set([...(u.badges || []), "guest"]));
  const token = jwtSign({ uid: u.id });
  return res.json({ ok: true, token, user: publicUser(u) });
});

app.post("/api/auth/logout", (req, res) => res.json({ ok: true }));

app.get("/api/users/me", auth, (req, res) => {
  return res.json({ ok: true, user: publicUser(req.user) });
});

// -------------------- STATE / BOOTSTRAP --------------------
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    createdAt: u.createdAt,
    lastSeen: u.lastSeen,
    bio: u.bio || "",
    color: u.color || "#dfe6ff",
    xp: u.xp || 0,
    level: u.level || 1,
    badges: u.badges || [],
    mode: u.presenceMode || "online",
  };
}

function buildOnlineUsers(onlineMap) {
  const out = [];
  for (const [uid, info] of onlineMap.entries()) {
    const u = users.byId[uid];
    if (!u) continue;
    out.push({ ...publicUser(u), mode: info.mode || u.presenceMode || "online" });
  }
  out.sort((a, b) => a.username.localeCompare(b.username));
  return out;
}

app.get("/api/state/bootstrap", auth, (req, res) => {
  const me = req.user;

  // Ensure global thread exists
  messages.global = Array.isArray(messages.global) ? messages.global : [];

  // Friends list -> also include DM messages with each friend (pair-based)
  const friends = (me.friends || [])
    .map((fid) => users.byId[fid])
    .filter(Boolean)
    .map((u) => ({
      id: u.id,
      username: u.username,
      color: u.color || "#dfe6ff",
      createdAt: u.createdAt,
      lastSeen: u.lastSeen,
      bio: u.bio || "",
      xp: u.xp || 0,
      level: u.level || 1,
      badges: u.badges || [],
      mode: u.presenceMode || "online",
      messages: [], // client accepts empty; it will live-update via socket
    }));

  // Groups owned/joined: for MVP, everyone is in groups they created or were invited to via code
  const myGroups = Object.values(groups.byId || {})
    .filter((g) => g && (g.members || []).includes(me.id))
    .map((g) => ({
      id: g.id,
      name: g.name,
      ownerId: g.ownerId,
      cooldownSeconds: g.cooldownSeconds || 3,
      rules: g.rules || "",
      messages: Array.isArray(messages.groups?.[g.id]) ? messages.groups[g.id] : [],
    }));

  return res.json({
    ok: true,
    me: publicUser(me),
    global: { messages: messages.global.slice(-120) },
    friends,
    groups: myGroups,
    onlineUsers: [], // socket fills this
    links: {
      github: "https://github.com/",
      kofi: "https://ko-fi.com/",
    },
  });
});

// -------------------- FRIENDS --------------------
app.post("/api/friends/add", auth, (req, res) => {
  const me = req.user;
  const username = safeStr(req.body?.username, 32).trim();
  if (!username) return res.status(400).json({ ok: false, error: "Missing username." });

  const other = getUserByUsername(username);
  if (!other) return res.status(404).json({ ok: false, error: "User not found." });
  if (other.id === me.id) return res.status(400).json({ ok: false, error: "Cannot add yourself." });

  me.friends = Array.isArray(me.friends) ? me.friends : [];
  other.friends = Array.isArray(other.friends) ? other.friends : [];

  if (!me.friends.includes(other.id)) me.friends.push(other.id);
  if (!other.friends.includes(me.id)) other.friends.push(me.id);

  persistAll();
  return res.json({ ok: true });
});

// -------------------- GROUPS --------------------
app.post("/api/groups/create", auth, (req, res) => {
  const me = req.user;
  const name = safeStr(req.body?.name, 48).trim();
  const cooldownSeconds = Math.max(0, Math.min(20, Number(req.body?.cooldownSeconds || 3)));

  if (!name) return res.status(400).json({ ok: false, error: "Missing group name." });

  const g = {
    id: id(),
    name,
    ownerId: me.id,
    cooldownSeconds,
    rules: "",
    createdAt: now(),
    members: [me.id],
  };

  groups.byId[g.id] = g;
  messages.groups[g.id] = messages.groups[g.id] || [];
  persistAll();

  io.to(me.id).emit("groups:update", { groups: userGroups(me.id).map((x) => ({ id: x.id, name: x.name, ownerId: x.ownerId, cooldownSeconds: x.cooldownSeconds })) });

  return res.json({ ok: true, group: g });
});

app.post("/api/groups/inviteLink", auth, (req, res) => {
  const me = req.user;
  const groupId = safeStr(req.body?.groupId, 48).trim();
  const g = groups.byId[groupId];
  if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
  if (g.ownerId !== me.id) return res.status(403).json({ ok: false, error: "Owner only." });

  const code = nanoid(10);
  g.inviteCode = code;
  persistAll();

  return res.json({ ok: true, inviteCode: code });
});

app.post("/api/groups/joinByCode", auth, (req, res) => {
  const me = req.user;
  const code = safeStr(req.body?.code, 32).trim();
  if (!code) return res.status(400).json({ ok: false, error: "Missing code." });

  const g = Object.values(groups.byId).find((x) => x.inviteCode === code);
  if (!g) return res.status(404).json({ ok: false, error: "Invalid code." });

  g.members = Array.isArray(g.members) ? g.members : [];
  if (!g.members.includes(me.id)) g.members.push(me.id);
  persistAll();

  io.emit("groups:update", { groups: Object.values(groups.byId).map((x) => ({ id: x.id, name: x.name, ownerId: x.ownerId, cooldownSeconds: x.cooldownSeconds })) });

  return res.json({ ok: true });
});

function userGroups(uid) {
  return Object.values(groups.byId || {}).filter((g) => g && (g.members || []).includes(uid));
}

// -------------------- PRESENCE --------------------
app.post("/api/presence", auth, (req, res) => {
  const me = req.user;
  const mode = safeStr(req.body?.mode, 20).trim();
  me.presenceMode = ["online", "idle", "dnd", "invisible"].includes(mode) ? mode : "online";
  persistAll();
  io.to(me.id).emit("presence:update", { me: { mode: me.presenceMode } });
  return res.json({ ok: true });
});

// -------------------- MESSAGES --------------------

// simple per-user cooldown tracking
const cooldownUntilByUser = new Map(); // uid -> ts
const lastClientIds = new Map(); // uid -> Set(clientId) with timestamps
function isDuplicateClientId(uid, clientId) {
  if (!clientId) return false;
  let entry = lastClientIds.get(uid);
  if (!entry) {
    entry = new Map(); // clientId -> ts
    lastClientIds.set(uid, entry);
  }
  const t = entry.get(clientId);
  // purge old
  const cutoff = now() - 120000;
  for (const [k, v] of entry.entries()) if (v < cutoff) entry.delete(k);
  if (t) return true;
  entry.set(clientId, now());
  return false;
}

function pushMessage(scope, targetId, msg) {
  if (scope === "global") {
    messages.global.push(msg);
    messages.global = messages.global.slice(-500);
    return;
  }
  if (scope === "dm") {
    const key = dmKey(msg.user.id, targetId);
    messages.dms[key] = Array.isArray(messages.dms[key]) ? messages.dms[key] : [];
    messages.dms[key].push(msg);
    messages.dms[key] = messages.dms[key].slice(-500);
    return;
  }
  if (scope === "group") {
    messages.groups[targetId] = Array.isArray(messages.groups[targetId]) ? messages.groups[targetId] : [];
    messages.groups[targetId].push(msg);
    messages.groups[targetId] = messages.groups[targetId].slice(-700);
  }
}

function dmKey(a, b) {
  const x = String(a), y = String(b);
  return x < y ? `${x}__${y}` : `${y}__${x}`;
}

function findMessage(scope, targetId, messageId) {
  if (scope === "global") return messages.global.find((m) => m.id === messageId) || null;
  if (scope === "dm") {
    const key = dmKey(targetId, targetId); // not used; dm retrieval uses scanning all pairs in this MVP
    // For edit/delete we will search all dm threads that include the user in auth middleware anyway.
    for (const arr of Object.values(messages.dms || {})) {
      const m = arr.find((x) => x.id === messageId);
      if (m) return m;
    }
    return null;
  }
  if (scope === "group") {
    const arr = messages.groups[targetId] || [];
    return arr.find((m) => m.id === messageId) || null;
  }
  return null;
}

app.post("/api/messages/send", auth, (req, res) => {
  const me = req.user;

  const scope = normalizeScope(req.body?.scope);
  const targetId = safeStr(req.body?.targetId, 64).trim() || null;
  const text = safeStr(req.body?.text, 2000).trim();
  const clientId = safeStr(req.body?.clientId, 80).trim();

  if (!scope) return res.status(400).json({ ok: false, error: "Invalid scope." });
  if (!text) return res.status(400).json({ ok: false, error: "Empty message." });

  // idempotency: stop double-send
  if (isDuplicateClientId(me.id, clientId)) {
    return res.json({ ok: true, message: null, deduped: true });
  }

  // scope checks
  if (scope === "dm") {
    const peer = users.byId[targetId];
    if (!peer) return res.status(404).json({ ok: false, error: "Peer not found." });
    // ensure they are friends
    const ok = (me.friends || []).includes(peer.id) && (peer.friends || []).includes(me.id);
    if (!ok) return res.status(403).json({ ok: false, error: "Not friends." });
  }
  if (scope === "group") {
    const g = groups.byId[targetId];
    if (!g) return res.status(404).json({ ok: false, error: "Group not found." });
    if (!(g.members || []).includes(me.id)) return res.status(403).json({ ok: false, error: "Not in group." });
  }

  // cooldown: global 2s, dm 1s, group uses group cooldown
  const base = scope === "global" ? 2000 : 1000;
  let cd = base;
  if (scope === "group") {
    const g = groups.byId[targetId];
    cd = Math.max(0, Math.min(20, Number(g?.cooldownSeconds || 3))) * 1000;
  }

  const until = cooldownUntilByUser.get(me.id) || 0;
  if (until && now() < until) {
    return res.status(429).json({ ok: false, error: "Cooldown", cooldownUntil: until, cooldownMs: cd });
  }

  const newUntil = now() + cd;
  cooldownUntilByUser.set(me.id, newUntil);

  // message object
  const msg = {
    id: id(),
    ts: now(),
    scope,
    targetId: targetId,
    text,
    kind: "message",
    editedAt: null,
    user: publicUser(me),
  };

  // XP on send
  grantXp(me, scope === "global" ? 5 : 7);

  pushMessage(scope, targetId, msg);
  persistAll();

  // Emit to correct audience
  if (scope === "global") {
    io.emit("message:new", msg);
  } else if (scope === "dm") {
    io.to(me.id).emit("message:new", msg);
    io.to(targetId).emit("message:new", msg);
  } else if (scope === "group") {
    io.to(`group:${targetId}`).emit("message:new", msg);
  }

  return res.json({ ok: true, message: msg, cooldownUntil: newUntil, cooldownMs: cd });
});

app.post("/api/messages/edit", auth, (req, res) => {
  const me = req.user;
  const messageId = safeStr(req.body?.messageId, 80).trim();
  const text = safeStr(req.body?.text, 2000).trim();
  if (!messageId || !text) return res.status(400).json({ ok: false, error: "Missing." });

  // find + validate ownership + age <= 1 min
  let msg = null;
  let where = null;

  // global
  msg = messages.global.find((m) => m.id === messageId);
  if (msg) where = { scope: "global", targetId: null, list: messages.global };

  if (!msg) {
    // dm
    for (const [k, arr] of Object.entries(messages.dms || {})) {
      const found = arr.find((m) => m.id === messageId);
      if (found) {
        msg = found;
        where = { scope: "dm", targetId: null, list: arr };
        break;
      }
    }
  }
  if (!msg) {
    // group
    for (const [gid, arr] of Object.entries(messages.groups || {})) {
      const found = arr.find((m) => m.id === messageId);
      if (found) {
        msg = found;
        where = { scope: "group", targetId: gid, list: arr };
        break;
      }
    }
  }

  if (!msg) return res.status(404).json({ ok: false, error: "Not found." });
  if (msg.user?.id !== me.id) return res.status(403).json({ ok: false, error: "Not yours." });

  const age = now() - (msg.ts || 0);
  if (age > 60_000) return res.status(403).json({ ok: false, error: "Edit window expired." });

  msg.text = text;
  msg.editedAt = now();
  persistAll();

  io.emit("message:edit", msg);
  return res.json({ ok: true, message: msg });
});

app.post("/api/messages/delete", auth, (req, res) => {
  const me = req.user;
  const messageId = safeStr(req.body?.messageId, 80).trim();
  if (!messageId) return res.status(400).json({ ok: false, error: "Missing." });

  // locate
  let scope = null;
  let targetId = null;
  let arr = null;
  let msg = null;

  msg = messages.global.find((m) => m.id === messageId);
  if (msg) {
    scope = "global";
    arr = messages.global;
  }

  if (!msg) {
    for (const [k, a] of Object.entries(messages.dms || {})) {
      const found = a.find((m) => m.id === messageId);
      if (found) {
        msg = found;
        scope = "dm";
        arr = a;
        break;
      }
    }
  }

  if (!msg) {
    for (const [gid, a] of Object.entries(messages.groups || {})) {
      const found = a.find((m) => m.id === messageId);
      if (found) {
        msg = found;
        scope = "group";
        targetId = gid;
        arr = a;
        break;
      }
    }
  }

  if (!msg) return res.status(404).json({ ok: false, error: "Not found." });
  if (msg.user?.id !== me.id) return res.status(403).json({ ok: false, error: "Not yours." });

  const age = now() - (msg.ts || 0);
  if (age > 60_000) return res.status(403).json({ ok: false, error: "Delete window expired." });

  const idx = arr.findIndex((m) => m.id === messageId);
  if (idx >= 0) arr.splice(idx, 1);
  persistAll();

  io.emit("message:delete", { scope, targetId, messageId });
  return res.json({ ok: true });
});

app.post("/api/messages/report", auth, (req, res) => {
  const me = req.user;
  const messageId = safeStr(req.body?.messageId, 80).trim();
  const reason = safeStr(req.body?.reason, 300).trim();

  if (!messageId) return res.status(400).json({ ok: false, error: "Missing messageId." });

  const rep = {
    id: id(),
    ts: now(),
    messageId,
    reason,
    reporter: publicUser(me),
    ip: req._ip || "unknown",
  };

  reports.items = Array.isArray(reports.items) ? reports.items : [];
  reports.items.push(rep);
  reports.items = reports.items.slice(-500);
  persistAll();

  io.emit("report:new", rep);

  return res.json({ ok: true });
});

// -------------------- BOT ADMIN API --------------------
app.post("/api/bot/deleteUser", botAuth, (req, res) => {
  const username = safeStr(req.body?.username, 64).trim();
  if (!username) return res.status(400).json({ ok: false, error: "Missing username." });

  const key = lower(username);
  const u = getUserByUsername(key);

  // strike+ban regardless of existence (keeps rule)
  const entry = strikeAndBanUser(key);

  // if user exists: remove account + scrub
  if (u) {
    // remove from byId/byName
    delete users.byId[u.id];
    delete users.byName[u.usernameLower];

    // remove from friends lists
    for (const user of Object.values(users.byId)) {
      user.friends = (user.friends || []).filter((fid) => fid !== u.id);
    }

    // remove from groups
    for (const g of Object.values(groups.byId)) {
      g.members = (g.members || []).filter((mid) => mid !== u.id);
    }

    // keep messages for now (optional: scrub)
    persistAll();
  }

  return res.json({
    ok: true,
    strikes: entry.strikes,
    until: entry.permanent ? null : entry.until,
    permanent: !!entry.permanent,
  });
});

app.post("/api/bot/announce", botAuth, (req, res) => {
  const text = safeStr(req.body?.text, 1200).trim();
  if (!text) return res.status(400).json({ ok: false, error: "Missing text." });

  const msg = {
    id: id(),
    ts: now(),
    scope: "global",
    targetId: null,
    text,
    kind: "announcement",
    editedAt: null,
    user: { id: "system", username: "tonkotsu", color: "hsl(45 90% 75%)", badges: ["announcement"], createdAt: now(), lastSeen: now(), bio: "", xp: 0, level: 1, mode: "online" },
  };

  pushMessage("global", null, msg);
  persistAll();
  io.emit("message:new", msg);

  return res.json({ ok: true });
});

app.post("/api/bot/banIp", botAuth, (req, res) => {
  const ip = safeStr(req.body?.ip, 80).trim();
  const seconds = Math.max(60, Math.min(60 * 60 * 24 * 30, Number(req.body?.seconds || 3600)));
  if (!ip) return res.status(400).json({ ok: false, error: "Missing ip." });

  banIp(ip, seconds * 1000);
  return res.json({ ok: true });
});

app.get("/api/bot/reports", botAuth, (req, res) => {
  const limit = Math.max(1, Math.min(50, Number(req.query?.limit || 10)));
  const items = (reports.items || []).slice(-limit);
  return res.json({ ok: true, reports: items });
});

// -------------------- SERVER + SOCKET --------------------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_URL === "*" ? true : CLIENT_URL, credentials: true },
});

// Online presence map: userId -> { sockets:Set, mode:string }
const online = new Map();

function buildOnlineUsersList() {
  return buildOnlineUsers(online);
}

function broadcastOnline() {
  const usersList = buildOnlineUsersList();
  io.emit("users:online", { users: usersList });
}

function setOnline(uid, socketId, mode) {
  let entry = online.get(uid);
  if (!entry) entry = { sockets: new Set(), mode: "online" };
  entry.sockets.add(socketId);
  if (mode) entry.mode = mode;
  online.set(uid, entry);
}

function setOffline(uid, socketId) {
  const entry = online.get(uid);
  if (!entry) return;
  entry.sockets.delete(socketId);
  if (entry.sockets.size === 0) online.delete(uid);
  else online.set(uid, entry);
}

io.on("connection", (socket) => {
  let authedUser = null;

  // client sends token via socket auth + also emits "auth"
  socket.on("auth", ({ token }) => {
    try {
      const payload = jwtVerify(token);
      const u = users.byId[payload.uid];
      if (!u) throw new Error("no user");
      authedUser = u;

      socket.join(u.id); // personal room
      setOnline(u.id, socket.id, u.presenceMode || "online");

      // send my presence back
      socket.emit("presence:update", { me: { mode: u.presenceMode || "online" } });

      // join any groups I am in (so group messages arrive)
      for (const g of userGroups(u.id)) socket.join(`group:${g.id}`);

      broadcastOnline();
    } catch (e) {
      socket.emit("session:revoked");
    }
  });

  socket.on("presence:set", ({ mode }) => {
    if (!authedUser) return;
    const m = ["online", "idle", "dnd", "invisible"].includes(mode) ? mode : "online";
    authedUser.presenceMode = m;
    persistAll();

    const entry = online.get(authedUser.id);
    if (entry) entry.mode = m;
    online.set(authedUser.id, entry || { sockets: new Set([socket.id]), mode: m });

    socket.emit("presence:update", { me: { mode: m } });
    broadcastOnline();
  });

  socket.on("groups:join", ({ groupId }) => {
    if (!authedUser) return;
    const g = groups.byId[String(groupId || "")];
    if (!g) return;
    if (!(g.members || []).includes(authedUser.id)) return;
    socket.join(`group:${g.id}`);
  });

  socket.on("dm:open", ({ peerId }) => {
    // no DM room needed; DMs are emitted to the two user rooms
    void peerId;
  });

  socket.on("typing", ({ scope, targetId, typing }) => {
    if (!authedUser) return;
    const sc = normalizeScope(scope);
    if (!sc) return;

    const payload = {
      scope: sc,
      targetId: targetId || null,
      users: typing ? [publicUser(authedUser)] : [],
    };

    if (sc === "global") {
      io.emit("typing:update", payload);
      return;
    }

    if (sc === "dm") {
      if (!targetId) return;
      io.to(authedUser.id).emit("typing:update", payload);
      io.to(String(targetId)).emit("typing:update", payload);
      return;
    }

    if (sc === "group") {
      if (!targetId) return;
      io.to(`group:${String(targetId)}`).emit("typing:update", payload);
      return;
    }
  });

  socket.on("disconnect", () => {
    if (authedUser) {
      setOffline(authedUser.id, socket.id);
      broadcastOnline();
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[tonkotsu] listening on ${PORT} (${NODE_ENV})`);
});
