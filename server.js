// server.js — tonkotsu.online backend (Express + Socket.IO)
// Drop-in replacement.
// - REST auth that matches your client expectations
// - Socket events that match your client expectations
// - Discord webhook logging for joins/logins + EVERY Global message (Global is public/logged)
// - Private chats NOT logged (placeholders for later)
// - Anti-abuse: cooldowns, link cooldown, banned words -> shadow mute
// - /status public endpoint (uptime, online, restart time)
// NOTE: Put DISCORD_WEBHOOK_URL in Render environment variables (do NOT hardcode)
//
// Required folders:
// - public/index.html
// - public/script.js
//
// Node: Render uses Node 18+ typically.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const express = require("express");
const { Server } = require("socket.io");
const bcrypt = require("bcryptjs");

// --------------------------- Config ---------------------------

const PORT = Number(process.env.PORT || 3000);
const TRUST_PROXY = String(process.env.TRUST_PROXY || "1") === "1";

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || ""; // must be set in Render env

const DATA_DIR = path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const GLOBAL_FILE = path.join(DATA_DIR, "global.json");
const TELEMETRY_FILE = path.join(DATA_DIR, "telemetry.json");
const GROUPS_FILE = path.join(DATA_DIR, "groups.json"); // placeholder; group system to expand later

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// --------------------------- Utilities ---------------------------

function now() {
  return Date.now();
}

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return safeJsonParse(fs.readFileSync(file, "utf8"), fallback);
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), "utf8");
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex");
}

function randHex(nBytes = 24) {
  return crypto.randomBytes(nBytes).toString("hex");
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function tsSeconds() {
  return Math.floor(now() / 1000);
}

function dayKeyUTC(ts = now()) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function normalizeUsername(u) {
  return String(u || "").trim();
}

function isValidUser(u) {
  // matches your earlier intent: 4–20, letters/numbers only
  return /^[A-Za-z0-9]{4,20}$/.test(String(u || "").trim());
}

function isValidPass(p) {
  // 4–72; allow more than alnum because "proper password-protected properly"
  // BUT keep it sane and avoid extremely weird inputs
  const s = String(p || "");
  if (s.length < 4 || s.length > 72) return false;
  return /^[\x20-\x7E]+$/.test(s); // printable ASCII
}

function isGuestUser(u) {
  return String(u || "").startsWith("guest_");
}

function escapeDiscordMentions(s) {
  let t = String(s || "");
  t = t.replace(/@everyone/g, "@\u200Beveryone").replace(/@here/g, "@\u200Bhere");
  return t;
}

function shortUA(ua) {
  const s = String(ua || "");
  return s.length > 180 ? s.slice(0, 180) + "…" : s;
}

function getClientIp(reqOrSocketHeaders, fallbackAddress) {
  // Render typically sends x-forwarded-for
  const xf = reqOrSocketHeaders["x-forwarded-for"];
  const raw =
    (Array.isArray(xf) ? xf[0] : xf) ||
    reqOrSocketHeaders["x-real-ip"] ||
    fallbackAddress ||
    "";
  return String(raw).split(",")[0].trim();
}

function extractFirstUrl(text) {
  const m = String(text || "").match(/\bhttps?:\/\/[^\s<>"']+/i);
  return m ? m[0] : null;
}

function extractUrls(text) {
  const rx = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
  const out = [];
  let m;
  const t = String(text || "");
  while ((m = rx.exec(t)) !== null) out.push(m[0]);
  return out;
}

// --------------------------- Moderation / Anti-abuse ---------------------------

// Block porn/18+ links entirely (simple keyword domain/path match)
const BLOCKED_LINK_RX = new RegExp(
  [
    "porn",
    "pornhub",
    "xvideos",
    "xnxx",
    "redtube",
    "youporn",
    "rule34",
    "hentai",
    "nhentai",
    "onlyfans",
    "fansly",
    "sex",
    "nsfw",
    "cam4",
    "chaturbate",
    "camgirl",
  ].join("|"),
  "i"
);

// Large-ish banned word list (starter; expand anytime)
const BANNED_WORD_RX = new RegExp(
  [
    // slurs (non-exhaustive)
    "\\bn[i1]gg(?:a|er)\\b",
    "\\bfag(?:got)?\\b",
    "\\btrann(?:y|ies)\\b",
    "\\bchink\\b",
    "\\bkike\\b",
    "\\bspic\\b",
    "\\bwetback\\b",
    // explicit 18+ / illegal
    "\\bchild\\s*porn\\b",
    "\\bcp\\b",
    "\\bloli\\b",
    "\\bunderage\\b",
    "\\brape\\b",
    "\\bincest\\b",
    "\\bbeastiality\\b",
    "\\bblowjob\\b",
    "\\bhandjob\\b",
    "\\bdeepthroat\\b",
    "\\bcumshot\\b",
    "\\bcreampie\\b",
    "\\bgangbang\\b",
    "\\banal\\b",
    "\\bthreesome\\b",
  ].join("|"),
  "i"
);

function isProhibited(text) {
  const t = String(text || "");
  if (BANNED_WORD_RX.test(t)) return true;
  const urls = extractUrls(t);
  for (const u of urls) {
    if (BLOCKED_LINK_RX.test(u)) return true;
  }
  return false;
}

// Cooldowns
function baseCooldownMs(userRec) {
  if (!userRec) return 3000;
  if (userRec.guest) return 5000;
  return 3000;
}

// link spam: max 1 link / 5 minutes
const LINK_COOLDOWN_MS = 5 * 60 * 1000;

// shadow mute duration
const SHADOW_MUTE_MS = 10 * 60 * 1000;

// --------------------------- Persistence Models ---------------------------

let users = readJson(USERS_FILE, {}); // key: username -> record
let globalHistory = readJson(GLOBAL_FILE, []); // array of messages
let telemetry = readJson(TELEMETRY_FILE, []); // array of records (bounded)
let groups = readJson(GROUPS_FILE, {}); // placeholder

function persistUsers() {
  writeJson(USERS_FILE, users);
}
function persistGlobal() {
  writeJson(GLOBAL_FILE, globalHistory);
}
function persistTelemetry() {
  writeJson(TELEMETRY_FILE, telemetry);
}
function persistGroups() {
  writeJson(GROUPS_FILE, groups);
}

function ensureUser(username) {
  if (!users[username]) {
    users[username] = {
      id: randHex(12),
      username,
      createdAt: now(),
      lastSeen: now(),
      passHash: null, // set for real accounts
      guest: false,
      trust: {
        score: 0.5, // 0..1
        notes: [],
      },
      security: {
        sessions: [], // {id, tokenHash, createdAt, lastSeen, ipHash, uaHash}
        loginHistory: [], // {ts, ok, ipHash, uaHash}
      },
      social: {
        blocked: [], // list of usernames
      },
      inbox: {
        unread: 0,
      },
      moderation: {
        shadowMutedUntil: 0,
        lastLinkAt: 0,
        nextAllowedAt: 0,
      },
      stats: {
        messages: 0,
        level: 1,
        xp: 0,
      },
      badges: ["BETA"],
    };
  }
  return users[username];
}

function safePublicUser(u) {
  return {
    id: u.id,
    username: u.username,
    level: u.stats?.level || 1,
  };
}

function pushGlobal(msg) {
  globalHistory.push(msg);
  if (globalHistory.length > 350) globalHistory.shift();
  persistGlobal();
}

function addLoginHistory(u, ok, ip, ua) {
  const ipHash = sha256Hex(ip);
  const uaHash = sha256Hex(ua);
  u.security.loginHistory.unshift({ ts: now(), ok: !!ok, ipHash, uaHash });
  if (u.security.loginHistory.length > 50) u.security.loginHistory.length = 50;
}

function newSession(u, ip, ua) {
  const sid = randHex(10);
  const token = randHex(24);
  const tokenHash = sha256Hex(token);

  const ipHash = sha256Hex(ip);
  const uaHash = sha256Hex(ua);

  u.security.sessions.unshift({
    id: sid,
    tokenHash,
    createdAt: now(),
    lastSeen: now(),
    ipHash,
    uaHash,
  });

  if (u.security.sessions.length > 10) u.security.sessions.length = 10;

  return { sid, token, tokenHash };
}

function touchSession(u, token, ip, ua) {
  const tokenHash = sha256Hex(token);
  const s = (u.security.sessions || []).find((x) => x.tokenHash === tokenHash);
  const ipHash = sha256Hex(ip);
  const uaHash = sha256Hex(ua);

  if (s) {
    s.lastSeen = now();
    s.ipHash = ipHash;
    s.uaHash = uaHash;
  } else {
    // unknown token: create a session record
    u.security.sessions.unshift({
      id: randHex(10),
      tokenHash,
      createdAt: now(),
      lastSeen: now(),
      ipHash,
      uaHash,
    });
    if (u.security.sessions.length > 10) u.security.sessions.length = 10;
  }
}

function revokeSession(u, sessionId) {
  u.security.sessions = (u.security.sessions || []).filter((s) => s.id !== sessionId);
}

function findUserByToken(token) {
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  for (const name of Object.keys(users)) {
    const u = users[name];
    if (!u || !u.passHash) continue;
    const sessions = u.security?.sessions || [];
    if (sessions.some((s) => s.tokenHash === tokenHash)) return u;
  }
  return null;
}

// --------------------------- Discord Webhook (Robust, No fetch required) ---------------------------

const webhookQueue = [];
let webhookBusy = false;

function enqueueWebhook(payload) {
  if (!DISCORD_WEBHOOK_URL) return;
  webhookQueue.push(payload);
  if (!webhookBusy) drainWebhookQueue().catch(() => {});
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function postWebhook(payload) {
  return new Promise((resolve) => {
    if (!DISCORD_WEBHOOK_URL) return resolve();

    let url;
    try {
      url = new URL(DISCORD_WEBHOOK_URL);
    } catch {
      return resolve();
    }

    const body = Buffer.from(JSON.stringify(payload), "utf8");

    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname + (url.search || ""),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length,
          "User-Agent": "tonkotsu-online/2.0",
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (d) => (chunks += d));
        res.on("end", async () => {
          if (res.statusCode === 429) {
            const data = safeJsonParse(chunks || "{}", {});
            const retryAfter = typeof data.retry_after === "number" ? data.retry_after : 1.5;
            // retryAfter can be seconds float
            await sleep(clamp(Math.ceil(retryAfter * 1000), 500, 15000));
            webhookQueue.unshift(payload);
          }
          resolve();
        });
      }
    );

    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

async function drainWebhookQueue() {
  webhookBusy = true;
  while (webhookQueue.length) {
    const payload = webhookQueue.shift();
    await postWebhook(payload);
    await sleep(350);
  }
  webhookBusy = false;
}

function discordSendEmbed({ title, description, fields = [], footer, color } = {}) {
  const embed = {
    title: String(title || "").slice(0, 256),
    description: String(description || "").slice(0, 4096),
    fields: (fields || []).slice(0, 25).map((f) => ({
      name: String(f.name || "").slice(0, 256),
      value: String(f.value || "").slice(0, 1024),
      inline: !!f.inline,
    })),
    timestamp: new Date().toISOString(),
  };
  if (footer) embed.footer = { text: String(footer).slice(0, 2048) };
  if (typeof color === "number") embed.color = color;
  enqueueWebhook({ embeds: [embed] });
}

function discordSendGlobalMessageEmbed({ user, text, ts, meta }) {
  const safeText = escapeDiscordMentions(String(text || ""));
  const desc = safeText.length > 3800 ? safeText.slice(0, 3800) + "…" : safeText;

  const fields = [
    { name: "User", value: `\`${user}\``, inline: true },
    { name: "When", value: `<t:${Math.floor((ts || now()) / 1000)}:F>`, inline: true },
  ];

  if (meta?.userId) fields.push({ name: "User ID", value: `\`${meta.userId}\``, inline: true });
  if (meta?.trustScore != null) fields.push({ name: "Trust", value: `\`${meta.trustScore}\``, inline: true });
  if (meta?.fingerprint) fields.push({ name: "FP (hash)", value: `\`${String(meta.fingerprint).slice(0, 20)}…\``, inline: true });

  discordSendEmbed({
    title: "Global Message",
    description: desc,
    fields,
    footer: "tonkotsu.online • Global is public/logged",
    color: 0x111111,
  });
}

function discordSendJoinEmbed({ kind, username, ipHash16, uaHash16, uaShortText, deviceHash16, userId }) {
  const title =
    kind === "new_account" ? "New Account Created" : kind === "login" ? "User Login" : kind === "guest" ? "Guest Created" : "Join";

  discordSendEmbed({
    title,
    description: `**${username}**`,
    fields: [
      { name: "Type", value: `\`${kind}\``, inline: true },
      { name: "When", value: `<t:${tsSeconds()}:F>`, inline: true },
      { name: "User ID", value: `\`${userId}\``, inline: true },
      { name: "IP Hash", value: `\`${ipHash16}…\``, inline: true },
      { name: "UA Hash", value: `\`${uaHash16}…\``, inline: true },
      { name: "Device Hash", value: `\`${deviceHash16}…\``, inline: true },
      { name: "UA (short)", value: `\`${uaShortText.replace(/`/g, "ˋ")}\``, inline: false },
    ],
    footer: "tonkotsu.online",
    color: 0x0b0b10,
  });
}

// --------------------------- Express App ---------------------------

const app = express();
if (TRUST_PROXY) app.set("trust proxy", 1);

app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 20000,
  pingInterval: 25000,
});

// --------------------------- Online Tracking ---------------------------

const socketsByUser = new Map(); // username -> Set(socket.id)
const userBySocket = new Map(); // socket.id -> username

function setOnline(username, socketId) {
  if (!socketsByUser.has(username)) socketsByUser.set(username, new Set());
  socketsByUser.get(username).add(socketId);
  userBySocket.set(socketId, username);
}

function setOffline(socketId) {
  const username = userBySocket.get(socketId);
  if (!username) return;
  userBySocket.delete(socketId);
  const set = socketsByUser.get(username);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) socketsByUser.delete(username);
  }
}

function onlineCount() {
  return socketsByUser.size;
}

function emitOnlineCount() {
  io.emit("online:update", { online: onlineCount() });
}

// --------------------------- Auth Middleware ---------------------------

function requireAuth(req, res, next) {
  const hdr = String(req.headers.authorization || "");
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
  const ip = getClientIp(req.headers, req.socket?.remoteAddress);
  const ua = String(req.headers["user-agent"] || "");

  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const u = findUserByToken(token);
  if (!u) return res.status(401).json({ ok: false, error: "Unauthorized" });

  touchSession(u, token, ip, ua);
  u.lastSeen = now();
  persistUsers();

  req.user = u;
  req.token = token;
  req.ipReal = ip;
  req.uaReal = ua;
  next();
}

// --------------------------- REST API ---------------------------

// health
app.get("/health", (req, res) => res.json({ ok: true }));

// public status page
const startedAt = now();
app.get("/status", (req, res) => {
  res.json({
    ok: true,
    uptimeSec: Math.floor((now() - startedAt) / 1000),
    online: onlineCount(),
    restartTime: new Date(startedAt).toISOString(),
    globalHistorySize: globalHistory.length,
  });
});

// telemetry hello (bot detection; no doxxing confirmed)
app.post("/api/telemetry/hello", (req, res) => {
  const ip = getClientIp(req.headers, req.socket?.remoteAddress);
  const ua = String(req.headers["user-agent"] || "");
  const ipHash = sha256Hex(ip);
  const uaHash = sha256Hex(ua);

  const record = {
    ts: now(),
    ipHash,
    uaHash,
    uaShort: shortUA(ua),
    tz: req.body?.tz || null,
    lang: req.body?.lang || null,
    platform: req.body?.platform || null,
    screen: req.body?.screen || null,
    vis: req.body?.vis || null,
    ref: req.body?.ref || null,
  };

  telemetry.unshift(record);
  if (telemetry.length > 500) telemetry.length = 500;
  persistTelemetry();

  res.json({ ok: true });
});

// login/create account
// Rules:
// - First login creates the account
// - After that, password must match exactly; cannot "claim" existing username
app.post("/api/auth/login", async (req, res) => {
  const username = normalizeUsername(req.body?.username);
  const password = String(req.body?.password || "");
  const guest = !!req.body?.guest;

  const ip = getClientIp(req.headers, req.socket?.remoteAddress);
  const ua = String(req.headers["user-agent"] || "");
  const ipHash16 = sha256Hex(ip).slice(0, 16);
  const uaHash16 = sha256Hex(ua).slice(0, 16);
  const deviceHash16 = sha256Hex(`${ip}::${ua}`).slice(0, 16);

  // guest flow
  if (guest) {
    const gname = `guest_${randHex(3)}`;
    const u = ensureUser(gname);
    u.guest = true;
    u.passHash = null;
    u.lastSeen = now();
    persistUsers();

    // Guests do not receive tokens; but your client expects token to exist.
    // To keep client stable, we STILL issue a token, but mark guest in profile.
    const session = newSession(u, ip, ua);
    persistUsers();

    discordSendJoinEmbed({
      kind: "guest",
      username: u.username,
      ipHash16,
      uaHash16,
      uaShortText: shortUA(ua),
      deviceHash16,
      userId: u.id,
    });

    return res.json({
      ok: true,
      token: session.token,
      user: {
        id: u.id,
        username: u.username,
        role: "guest",
        createdAt: u.createdAt,
        lastSeen: u.lastSeen,
        level: u.stats?.level || 1,
        badges: ["BETA"],
      },
      isNew: false,
    });
  }

  if (!isValidUser(username)) {
    return res.status(400).json({ ok: false, error: "Username must be 4–20 letters/numbers." });
  }
  if (!isValidPass(password)) {
    return res.status(400).json({ ok: false, error: "Password must be 4–72 characters." });
  }

  const existing = users[username] && users[username].passHash;

  // Account creation
  if (!existing) {
    const u = ensureUser(username);

    // If somehow record existed without passHash, treat as new claim now
    u.guest = false;
    u.passHash = await bcrypt.hash(password, 12);
    u.createdAt = u.createdAt || now();
    u.lastSeen = now();

    // badge
    u.badges = Array.isArray(u.badges) ? u.badges : ["BETA"];
    if (!u.badges.includes("EARLY USER")) u.badges.push("EARLY USER");

    // session
    const session = newSession(u, ip, ua);

    addLoginHistory(u, true, ip, ua);
    persistUsers();

    discordSendJoinEmbed({
      kind: "new_account",
      username: u.username,
      ipHash16,
      uaHash16,
      uaShortText: shortUA(ua),
      deviceHash16,
      userId: u.id,
    });

    return res.json({
      ok: true,
      token: session.token,
      user: {
        id: u.id,
        username: u.username,
        role: "user",
        createdAt: u.createdAt,
        lastSeen: u.lastSeen,
        level: u.stats?.level || 1,
        badges: u.badges,
        betaJoinAt: u.createdAt,
      },
      isNew: true,
    });
  }

  // Existing account: strict password match
  const u = ensureUser(username);
  const ok = await bcrypt.compare(password, u.passHash).catch(() => false);
  addLoginHistory(u, ok, ip, ua);
  if (!ok) {
    persistUsers();
    return res.status(401).json({ ok: false, error: "Incorrect password." });
  }

  u.guest = false;
  u.lastSeen = now();
  const session = newSession(u, ip, ua);
  persistUsers();

  discordSendJoinEmbed({
    kind: "login",
    username: u.username,
    ipHash16,
    uaHash16,
    uaShortText: shortUA(ua),
    deviceHash16,
    userId: u.id,
  });

  return res.json({
    ok: true,
    token: session.token,
    user: {
      id: u.id,
      username: u.username,
      role: "user",
      createdAt: u.createdAt,
      lastSeen: u.lastSeen,
      level: u.stats?.level || 1,
      badges: u.badges || ["BETA"],
      betaJoinAt: u.createdAt,
    },
    isNew: false,
  });
});

// me
app.get("/api/me", requireAuth, (req, res) => {
  const u = req.user;
  res.json({
    ok: true,
    user: {
      id: u.id,
      username: u.username,
      role: u.guest ? "guest" : "user",
      createdAt: u.createdAt,
      lastSeen: u.lastSeen,
      level: u.stats?.level || 1,
      badges: u.badges || ["BETA"],
      betaJoinAt: u.createdAt,
    },
  });
});

// global history
app.get("/api/global/history", (req, res) => {
  const limit = clamp(Number(req.query.limit || 80), 1, 200);
  const items = globalHistory.slice(-limit);
  res.json({ ok: true, items });
});

// inbox count (placeholder; you can expand later)
app.get("/api/inbox/count", requireAuth, (req, res) => {
  const u = req.user;
  const count = Number(u.inbox?.unread || 0);
  res.json({ ok: true, count });
});

// blocks list (placeholder)
app.get("/api/blocks", requireAuth, (req, res) => {
  const u = req.user;
  const items = (u.social?.blocked || []).map((name) => ({
    username: name,
    blockedAt: u.social?.blockedAt?.[name] || null,
  }));
  res.json({ ok: true, items });
});

app.post("/api/blocks/unblock", requireAuth, (req, res) => {
  const u = req.user;
  const target = String(req.body?.username || "").trim();
  u.social.blocked = (u.social.blocked || []).filter((x) => x !== target);
  if (u.social.blockedAt && u.social.blockedAt[target]) delete u.social.blockedAt[target];
  persistUsers();
  res.json({ ok: true });
});

// security overview
app.get("/api/security/overview", requireAuth, (req, res) => {
  const u = req.user;

  const loginHistory = (u.security?.loginHistory || []).slice(0, 15).map((h) => ({
    when: h.ts,
    // show masked hashes only
    ip: h.ipHash ? `${String(h.ipHash).slice(0, 16)}…` : "—",
    ua: h.uaHash ? `${String(h.uaHash).slice(0, 16)}…` : "—",
    ok: !!h.ok,
  }));

  const tokenHash = sha256Hex(req.token);
  const sessions = (u.security?.sessions || []).slice(0, 12).map((s) => ({
    id: s.id,
    current: s.tokenHash === tokenHash,
    ip: s.ipHash ? `${String(s.ipHash).slice(0, 16)}…` : "—",
    lastSeen: s.lastSeen,
  }));

  const events = (u.security?.events || []).slice(0, 15);

  res.json({
    ok: true,
    loginHistory,
    sessions,
    events,
  });
});

app.post("/api/security/revoke-session", requireAuth, (req, res) => {
  const u = req.user;
  const sessionId = String(req.body?.sessionId || "").trim();
  if (!sessionId) return res.status(400).json({ ok: false, error: "Missing sessionId" });

  revokeSession(u, sessionId);
  persistUsers();

  // If they revoked their current token, it will fail next call; client handles it.
  res.json({ ok: true });
});

app.post("/api/security/change-password", requireAuth, async (req, res) => {
  const u = req.user;
  if (u.guest) return res.status(403).json({ ok: false, error: "Guests cannot change password." });

  const newPw = String(req.body?.password || "");
  if (!isValidPass(newPw)) return res.status(400).json({ ok: false, error: "Invalid password." });

  u.passHash = await bcrypt.hash(newPw, 12);
  u.security.sessions = []; // revoke all sessions on password change
  u.security.events = u.security.events || [];
  u.security.events.unshift({ type: "password_change", when: now(), detail: "Password changed; sessions revoked." });
  if (u.security.events.length > 50) u.security.events.length = 50;
  persistUsers();

  res.json({ ok: true });
});

app.post("/api/security/change-username", requireAuth, async (req, res) => {
  const u = req.user;
  if (u.guest) return res.status(403).json({ ok: false, error: "Guests cannot change username." });

  const newName = normalizeUsername(req.body?.username);
  if (!isValidUser(newName)) return res.status(400).json({ ok: false, error: "Invalid username." });
  if (users[newName]) return res.status(409).json({ ok: false, error: "Username already in use." });

  // Move record
  const oldName = u.username;
  const rec = users[oldName];
  delete users[oldName];
  rec.username = newName;
  users[newName] = rec;

  // Update block lists referencing old username (basic)
  for (const k of Object.keys(users)) {
    const other = users[k];
    other.social = other.social || { blocked: [] };
    other.social.blocked = (other.social.blocked || []).map((x) => (x === oldName ? newName : x));
    if (other.social.blockedAt && other.social.blockedAt[oldName]) {
      other.social.blockedAt[newName] = other.social.blockedAt[oldName];
      delete other.social.blockedAt[oldName];
    }
  }

  rec.security.events = rec.security.events || [];
  rec.security.events.unshift({ type: "username_change", when: now(), detail: `Renamed ${oldName} → ${newName}` });
  if (rec.security.events.length > 50) rec.security.events.length = 50;

  persistUsers();

  res.json({
    ok: true,
    user: {
      id: rec.id,
      username: rec.username,
      role: "user",
      createdAt: rec.createdAt,
      lastSeen: rec.lastSeen,
      level: rec.stats?.level || 1,
      badges: rec.badges || ["BETA"],
      betaJoinAt: rec.createdAt,
    },
  });
});

// REST fallback global send (client uses this if socket down)
app.post("/api/global/send", requireAuth, (req, res) => {
  const u = req.user;
  const text = String(req.body?.text || "").trim();
  const ip = req.ipReal;
  const ua = req.uaReal;

  const result = handleGlobalSendCore({ u, text, ip, ua, via: "rest" });
  if (!result.ok) return res.status(429).json({ ok: false, error: result.error });

  res.json({
    ok: true,
    cooldownMs: result.cooldownMs,
    shadow: result.shadow === true,
  });
});

// --------------------------- Socket.IO ---------------------------

io.on("connection", (socket) => {
  let authed = null; // user record
  let token = null;

  const headers = socket.handshake.headers || {};
  const ip = getClientIp(headers, socket.handshake.address);
  const ua = String(headers["user-agent"] || "");

  function setAuthFromToken(t) {
    if (!t) return false;
    const u = findUserByToken(t);
    if (!u) return false;

    token = t;
    authed = u;

    touchSession(u, t, ip, ua);
    u.lastSeen = now();
    persistUsers();

    setOnline(u.username, socket.id);
    emitOnlineCount();

    // notify count to this socket
    socket.emit("notify:count", { count: Number(u.inbox?.unread || 0) });

    return true;
  }

  // initial auth via socket.io "auth" field
  const initialToken = socket.handshake.auth?.token;
  if (initialToken) setAuthFromToken(String(initialToken));

  socket.on("disconnect", () => {
    setOffline(socket.id);
    if (authed) {
      authed.lastSeen = now();
      persistUsers();
    }
    emitOnlineCount();
  });

  socket.on("hello", () => {
    // lightweight; already stored via /api/telemetry/hello too
  });

  socket.on("online:get", () => {
    socket.emit("online:update", { online: onlineCount() });
  });

  // Client expects: socket.emit("global:history", {limit}, ack)
  socket.on("global:history", (payload, ack) => {
    const limit = clamp(Number(payload?.limit || 80), 1, 200);
    const items = globalHistory.slice(-limit);
    if (typeof ack === "function") ack({ ok: true, items });
    else socket.emit("global:history", { items });
  });

  // Client expects: socket.on("global:msg", msg)
  // We broadcast via io.emit("global:msg", msg)

  // Client expects: socket.emit("global:send", {text}, ack)
  socket.on("global:send", (payload, ack) => {
    if (!authed) {
      if (typeof ack === "function") ack({ ok: false, error: "Unauthorized" });
      return;
    }

    const text = String(payload?.text || "").trim();
    const result = handleGlobalSendCore({ u: authed, text, ip, ua, via: "socket" });

    if (!result.ok) {
      if (typeof ack === "function") ack({ ok: false, error: result.error });
      return;
    }

    if (typeof ack === "function") {
      ack({
        ok: true,
        cooldownMs: result.cooldownMs,
        shadow: result.shadow === true,
      });
    }
  });

  // If client token becomes invalid (e.g., sessions revoked), you can push this.
  // For now, the REST endpoints will fail and client will return to login.
});

// --------------------------- Global Send Core ---------------------------

const perUser = new Map(); // username -> runtime anti-spam (in-memory)

function userRuntime(username) {
  if (!perUser.has(username)) {
    perUser.set(username, {
      lastLinkAt: 0,
      nextAllowedAt: 0,
      shadowMutedUntil: 0,
      recent: [],
    });
  }
  return perUser.get(username);
}

function trustScore(u) {
  // Basic score, 0..1; expand later
  let s = typeof u.trust?.score === "number" ? u.trust.score : 0.5;
  if (u.guest) s -= 0.15;
  if ((u.security?.loginHistory || []).length >= 10) s += 0.05;
  if ((u.stats?.messages || 0) >= 50) s += 0.1;
  return clamp(Number(s || 0.5), 0, 1);
}

function fingerprintHash(ip, ua) {
  // hashed fingerprint, not reversible (still be mindful)
  return sha256Hex(`${ip}::${ua}`).slice(0, 32);
}

function handleGlobalSendCore({ u, text, ip, ua, via }) {
  if (!u) return { ok: false, error: "Unauthorized" };

  const uname = u.username;
  const runtime = userRuntime(uname);

  if (!text) return { ok: false, error: "Empty message." };
  if (text.length > 1200) return { ok: false, error: "Message too long." };

  // Shadow mute check
  const shadowUntil = Math.max(Number(runtime.shadowMutedUntil || 0), Number(u.moderation?.shadowMutedUntil || 0));
  if (shadowUntil && now() < shadowUntil) {
    // Appears to sender only (client optimistic already shows it).
    // We still ack OK but mark shadow.
    return { ok: true, shadow: true, cooldownMs: baseCooldownMs(u) };
  }

  // Prohibited content triggers shadow mute
  if (isProhibited(text)) {
    const until = now() + SHADOW_MUTE_MS;
    runtime.shadowMutedUntil = until;
    u.moderation.shadowMutedUntil = until;
    persistUsers();

    // Log to Discord for moderation awareness (still not visible publicly)
    discordSendEmbed({
      title: "Shadow Mute Triggered",
      description: `Prohibited content detected. User shadow-muted.\n\nUser: **${uname}**`,
      fields: [
        { name: "When", value: `<t:${tsSeconds()}:F>`, inline: true },
        { name: "Duration", value: `${Math.floor(SHADOW_MUTE_MS / 60000)}m`, inline: true },
        { name: "Message (preview)", value: `\`${escapeDiscordMentions(text).slice(0, 250)}\``, inline: false },
        { name: "FP (hash)", value: `\`${fingerprintHash(ip, ua).slice(0, 20)}…\``, inline: true },
      ],
      footer: "tonkotsu.online",
      color: 0x8b0000,
    });

    // Ack OK but shadow
    return { ok: true, shadow: true, cooldownMs: baseCooldownMs(u) };
  }

  // Link rules
  const url = extractFirstUrl(text);
  if (url) {
    // hard block porn/18+ links
    if (BLOCKED_LINK_RX.test(url)) {
      const until = now() + SHADOW_MUTE_MS;
      runtime.shadowMutedUntil = until;
      u.moderation.shadowMutedUntil = until;
      persistUsers();

      discordSendEmbed({
        title: "Blocked Link (Shadow Mute)",
        description: `Blocked 18+ link attempt.\nUser: **${uname}**`,
        fields: [
          { name: "URL", value: `\`${url.slice(0, 240)}\``, inline: false },
          { name: "When", value: `<t:${tsSeconds()}:F>`, inline: true },
          { name: "FP (hash)", value: `\`${fingerprintHash(ip, ua).slice(0, 20)}…\``, inline: true },
        ],
        footer: "tonkotsu.online",
        color: 0x8b0000,
      });

      return { ok: true, shadow: true, cooldownMs: baseCooldownMs(u) };
    }

    // link spam rate limit
    const lastLinkAt = Math.max(Number(runtime.lastLinkAt || 0), Number(u.moderation?.lastLinkAt || 0));
    if (lastLinkAt && now() - lastLinkAt < LINK_COOLDOWN_MS) {
      const leftMs = LINK_COOLDOWN_MS - (now() - lastLinkAt);
      return { ok: false, error: `Link cooldown: ${Math.ceil(leftMs / 1000)}s left.` };
    }
  }

  // Cooldown
  const cdMs = baseCooldownMs(u);
  const nextAllowedAt = Number(runtime.nextAllowedAt || 0);
  if (nextAllowedAt && now() < nextAllowedAt) {
    const leftMs = nextAllowedAt - now();
    return { ok: false, error: `Cooldown active (${Math.ceil(leftMs / 100) / 10}s left).` };
  }

  runtime.nextAllowedAt = now() + cdMs;

  // Persist last link time
  if (url) {
    runtime.lastLinkAt = now();
    u.moderation.lastLinkAt = now();
    persistUsers();
  }

  // Build message
  const msg = {
    id: randHex(10),
    user: uname,
    text,
    ts: now(),
    url: url || null,
  };

  // Global is public and logged to Discord
  pushGlobal(msg);

  const meta = {
    userId: u.id,
    trustScore: trustScore(u).toFixed(2),
    fingerprint: fingerprintHash(ip, ua),
    via,
  };
  discordSendGlobalMessageEmbed({ user: msg.user, text: msg.text, ts: msg.ts, meta });

  // Broadcast to all clients
  io.emit("global:msg", msg);

  // Update online count occasionally (cheap)
  io.emit("online:update", { online: onlineCount() });

  // Simple stats
  u.stats.messages = (u.stats.messages || 0) + 1;
  u.lastSeen = now();
  persistUsers();

  return { ok: true, cooldownMs: cdMs };
}

// --------------------------- Boot ---------------------------

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
  if (!DISCORD_WEBHOOK_URL) {
    console.log("WARNING: DISCORD_WEBHOOK_URL is not set. Webhook logging will not work.");
  }
});

