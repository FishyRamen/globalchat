// server.js — tonkotsu.online (Render-friendly) — single-file server
// Features implemented to match your script.js + requirements:
// - Account creation/login with bcryptjs (prevents username takeover with wrong password)
// - Session tokens + session manager + revoke + login history
// - Channels: global + group + DM
// - Group management: add/remove members, transfer ownership, mute/unmute, limit slider (down-only)
// - Cooldown + link cooldown (1 link / 5 min) + anti-link-spam
// - Content policy: blocks 18+ links; "bad stuff" triggers temporary shadow-mute (sender won't know)
// - Profiles: badges (beta/early user + milestones), stats (createdAt, lastSeen, level), status
// - Blocked users list (server-stored) + block/unblock events
//
// Deploy notes:
// 1) Ensure package.json includes:
//    "dependencies": { "express": "^4.19.2", "socket.io": "^4.7.5", "bcryptjs": "^2.4.3", "nanoid": "^5.0.7" }
// 2) Optional env:
//    - PORT (Render provides)
//    - DATA_DIR (default ./data)
//    - BETA_MODE=1 (marks new accounts as beta early users)
//    - PUBLIC_GROUPS=1 (enables group discovery/joining)
//    - DEFAULT_COOLDOWN_MS=4000
//
// This file serves static files from ./public (index.html, script.js, etc).

'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const { Server } = require('socket.io');

/* ----------------------------- Config ----------------------------- */
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DEFAULT_COOLDOWN_MS = clampInt(process.env.DEFAULT_COOLDOWN_MS, 300, 600000, 4000);
const LINK_COOLDOWN_MS = 5 * 60 * 1000; // 1 link per 5 minutes
const PUBLIC_GROUPS = String(process.env.PUBLIC_GROUPS || '1') === '1';
const BETA_MODE = String(process.env.BETA_MODE || '1') === '1';

// Shadow mute duration on "bad stuff"
const SHADOW_MUTE_MS = 30 * 60 * 1000;

// Message history retention
const MAX_HISTORY_PER_CHANNEL = 800;

// Simple per-user / per-channel cooldown memory (in ms)
const cooldowns = new Map(); // key `${user}|${channel}` -> until
const linkCooldowns = new Map(); // key `${user}` -> until

// Online presence
const onlineUsers = new Map(); // usernameLower -> { username, sockets:Set, lastSeen, status }
const socketToUser = new Map(); // socket.id -> usernameLower

/* ----------------------------- App / Server ----------------------------- */
ensureDir(DATA_DIR);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Serve static site
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h', etag: true }));

app.get('/health', (req, res) => res.status(200).send('ok'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

/* ----------------------------- Persistence ----------------------------- */
const DB_PATH = path.join(DATA_DIR, 'db.json');

const db = loadDB(DB_PATH);
/*
db shape:
{
  version: 1,
  users: {
    "alice": {
      username: "alice",
      passHash: "...",
      createdAt: 123,
      lastSeen: 123,
      level: 1,
      badges: [],
      isBeta: true,
      blocked: ["bob"],
      shadowMutedUntil: 0,
      sessions: [{ id, token, createdAt, lastSeen, ip, ua }],
      loginHistory: [{ ts, ip, ua }],
    }
  },
  channels: {
    "global": { id:"global", type:"global", name:"global", ... },
    "c_xxx": { id, type:"group"/"dm", name, owner, members:[username], limit, muted:[username], isPublic, lastActivity, history:[...] }
  }
}
*/

initDB();

/* ----------------------------- Content rules ----------------------------- */
const urlRegex = /\bhttps?:\/\/[^\s<>()]+\b/ig;

const bannedHosts = new Set([
  'pornhub.com',
  'xvideos.com',
  'xhamster.com',
  'xnxx.com',
  'redtube.com',
  'onlyfans.com',
  'fansly.com',
]);

// Huge-but-not-too-huge "bad stuff" list -> triggers shadow-mute (and client also blocks obvious)
// We avoid providing explicit slurs in full; we use patterns.
const badPatterns = [
  // Sexual content / porn terms
  /\b(porn|pornhub|xvideos|xhamster|xnxx|redtube|onlyfans|fansly|hentai)\b/i,
  /\b(nude|nudes|naked|sex\s?chat|escort|camgirl|cam\s?site)\b/i,
  /\b(blowjob|handjob|anal|deepthroat|cumshot|creampie)\b/i,
  /\b(rape|molest|incest|bestiality|zoophilia)\b/i,

  // Slurs (patterned)
  /\b(n[\W_]*i[\W_]*g[\W_]*g[\W_]*e[\W_]*r|n[\W_]*i[\W_]*g[\W_]*g[\W_]*a)\b/i,
  /\b(f[\W_]*a[\W_]*g[\W_]*g[\W_]*o[\W_]*t|f[\W_]*a[\W_]*g)\b/i,
  /\b(r[\W_]*e[\W_]*t[\W_]*a[\W_]*r[\W_]*d)\b/i,
  /\b(k[\W_]*i[\W_]*k)\b/i,
  /\b(c[\W_]*h[\W_]*i[\W_]*n[\W_]*k)\b/i,

  // 18+ / explicit content cues
  /\b(underage|cp\b|loli|lolicon)\b/i,
];

function containsBadStuff(text) {
  const t = String(text || '');
  return badPatterns.some((re) => re.test(t));
}

function extractUrls(text) {
  const t = String(text || '');
  const found = t.match(urlRegex) || [];
  return found.map(u => u.replace(/[)\].,!?:;]+$/g, ''));
}

function isBannedUrl(u) {
  try {
    const url = new URL(u);
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (bannedHosts.has(host)) return true;

    const hay = (host + url.pathname + url.search).toLowerCase();
    if (/(porn|hentai|xxx|sex|nude|onlyfans|xvideos|xnxx|xhamster)/i.test(hay)) return true;

    return false;
  } catch {
    return true;
  }
}

function isSpammyUrls(urls) {
  // "no link spamming" (server enforces more strongly; client also blocks 3+)
  return urls.length >= 3;
}

/* ----------------------------- Helpers ----------------------------- */
function now() { return Date.now(); }

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function safeUA(socket) {
  return String(socket?.handshake?.headers?.['user-agent'] || '').slice(0, 200);
}

function safeIP(socket) {
  // Render proxy: x-forwarded-for may exist
  const xf = socket?.handshake?.headers?.['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim().slice(0, 80);
  return String(socket?.handshake?.address || '').slice(0, 80);
}

function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase();
}

function validateUsername(u) {
  return /^[a-z0-9_]{4,20}$/i.test(String(u || '').trim());
}

function validatePassword(p) {
  return /^[a-z0-9_]{4,32}$/i.test(String(p || '').trim());
}

function getUserPublic(user, status = null) {
  const lvl = Number.isFinite(user.level) ? user.level : 1;
  const badges = Array.isArray(user.badges) ? user.badges.slice() : [];

  // add milestone badges
  const thresholds = [10, 25, 50, 75, 100];
  for (const t of thresholds) if (lvl >= t) badges.push(`Lv ${t}`);

  if (user.isBeta) badges.push('Early User');

  return {
    username: user.username,
    createdAt: user.createdAt || null,
    lastSeen: user.lastSeen || null,
    level: lvl,
    badges: Array.from(new Set(badges)).slice(0, 20),
    isBeta: !!user.isBeta,
    status: status || null,
  };
}

function channelForClient(chan, viewerUserLower) {
  const c = chan || {};
  const out = {
    id: c.id,
    name: c.name,
    type: c.type,
    owner: c.owner || null,
    membersCount: Array.isArray(c.members) ? c.members.length : (c.membersCount || null),
    limit: Number.isFinite(c.limit) ? c.limit : null,
    cooldownMs: Number.isFinite(c.cooldownMs) ? c.cooldownMs : null,
    muted: Array.isArray(c.muted) ? c.muted.slice() : [],
    unread: 0,
    lastActivity: Number.isFinite(c.lastActivity) ? c.lastActivity : 0,
  };

  // Hide member list by default; only provided via getGroup
  if (c.type === 'dm') out.isDM = true;
  if (c.type === 'group') out.isGroup = true;

  // For DM, show the other participant as the channel name
  if (c.type === 'dm' && Array.isArray(c.members) && viewerUserLower) {
    const other = c.members.find(m => normalizeUsername(m) !== viewerUserLower);
    if (other) out.name = other;
  }

  return out;
}

function canViewChannel(chan, usernameLower) {
  if (!chan) return false;
  if (chan.type === 'global') return true;
  if (!usernameLower) return false;
  if (chan.type === 'dm' || chan.type === 'group') {
    return Array.isArray(chan.members) && chan.members.some(m => normalizeUsername(m) === usernameLower);
  }
  return false;
}

/* ----------------------------- DB ops ----------------------------- */
function loadDB(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed;
  } catch (e) {
    console.error('DB load error:', e);
    return null;
  }
}

function saveDB() {
  // atomic-ish save
  const tmp = DB_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DB_PATH);
  } catch (e) {
    console.error('DB save error:', e);
  }
}

function initDB() {
  if (!db || typeof db !== 'object') {
    // create fresh
    const fresh = {
      version: 1,
      users: {},
      channels: {},
    };
    Object.assign(dbRef(), fresh);
  }

  if (!db.users) db.users = {};
  if (!db.channels) db.channels = {};

  // ensure global channel
  if (!db.channels.global) {
    db.channels.global = {
      id: 'global',
      type: 'global',
      name: 'global',
      owner: null,
      members: [],
      limit: null,
      muted: [],
      isPublic: true,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      lastActivity: 0,
      history: [],
    };
  }

  saveDB();
}

function dbRef() {
  // db may be null; ensure it's an object reference
  if (!global.__TONKOTSU_DB__) global.__TONKOTSU_DB__ = {};
  return global.__TONKOTSU_DB__;
}

// Ensure db points to the global reference (so init can assign)
if (!global.__TONKOTSU_DB__) global.__TONKOTSU_DB__ = {};
if (db) Object.assign(global.__TONKOTSU_DB__, db);
const dbObj = global.__TONKOTSU_DB__;
Object.defineProperty(global, '__TONKOTSU_DB_OBJ__', { value: dbObj });

function getDB() { return dbObj; }
function getUser(usernameLower) { return getDB().users[usernameLower] || null; }

function setUser(usernameLower, userObj) {
  getDB().users[usernameLower] = userObj;
  saveDB();
}

function delUser(usernameLower) {
  delete getDB().users[usernameLower];
  saveDB();
}

function getChannel(id) { return getDB().channels[id] || null; }

function setChannel(id, chanObj) {
  getDB().channels[id] = chanObj;
  saveDB();
}

function listChannels() { return Object.values(getDB().channels || {}); }

/* ----------------------------- Channels management ----------------------------- */
function createGroupChannel({ name, owner, limit, members, isPublic }) {
  const id = 'c_' + nanoid(10);
  const uniq = uniqueUsernames([owner, ...(members || [])]);
  const chan = {
    id,
    type: 'group',
    name: String(name || 'group').slice(0, 28),
    owner,
    members: uniq,
    limit: clampInt(limit, 2, 200, 30),
    muted: [],
    isPublic: !!isPublic,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    lastActivity: now(),
    history: [],
  };
  setChannel(id, chan);
  return chan;
}

function findOrCreateDM(a, b) {
  const aL = normalizeUsername(a);
  const bL = normalizeUsername(b);
  const existing = listChannels().find(c =>
    c.type === 'dm' &&
    Array.isArray(c.members) &&
    c.members.length === 2 &&
    c.members.some(m => normalizeUsername(m) === aL) &&
    c.members.some(m => normalizeUsername(m) === bL)
  );
  if (existing) return existing;

  const id = 'd_' + nanoid(10);
  const chan = {
    id,
    type: 'dm',
    name: 'dm',
    owner: null,
    members: uniqueUsernames([a, b]),
    limit: null,
    muted: [],
    isPublic: false,
    cooldownMs: DEFAULT_COOLDOWN_MS,
    lastActivity: now(),
    history: [],
  };
  setChannel(id, chan);
  return chan;
}

function uniqueUsernames(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const u = String(x || '').trim();
    if (!u) continue;
    const k = normalizeUsername(u);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
  }
  return out;
}

/* ----------------------------- History ----------------------------- */
function pushHistory(channelId, msg) {
  const chan = getChannel(channelId);
  if (!chan) return;

  if (!Array.isArray(chan.history)) chan.history = [];
  chan.history.push(msg);

  // cap history
  if (chan.history.length > MAX_HISTORY_PER_CHANNEL) {
    chan.history.splice(0, chan.history.length - MAX_HISTORY_PER_CHANNEL);
  }

  chan.lastActivity = now();
  setChannel(channelId, chan);
}

function getVisibleHistory(channelId, viewerLower, limit = 60) {
  const chan = getChannel(channelId);
  if (!chan || !Array.isArray(chan.history)) return [];

  // filter hidden (shadow muted) messages if not the sender
  const items = [];
  for (let i = chan.history.length - 1; i >= 0 && items.length < limit; i--) {
    const m = chan.history[i];
    if (!m) continue;

    // hidden means only visible to sender
    if (m.hiddenForOthers) {
      if (normalizeUsername(m.username) !== viewerLower) continue;
    }

    items.push(m);
  }

  return items.reverse();
}

/* ----------------------------- Presence ----------------------------- */
function setUserOnline(usernameLower, socket) {
  const u = getUser(usernameLower);
  const display = u ? u.username : usernameLower;

  let entry = onlineUsers.get(usernameLower);
  if (!entry) {
    entry = { username: display, sockets: new Set(), lastSeen: now(), status: 'online' };
    onlineUsers.set(usernameLower, entry);
  }
  entry.username = display;
  entry.sockets.add(socket.id);
  entry.lastSeen = now();
  entry.status = 'online';
}

function setUserOfflineIfNeeded(usernameLower) {
  const entry = onlineUsers.get(usernameLower);
  if (!entry) return;
  if (entry.sockets.size === 0) {
    entry.status = 'offline';
    entry.lastSeen = now();
  }
}

function broadcastOnline() {
  const list = [];
  for (const [k, v] of onlineUsers.entries()) {
    list.push({
      username: v.username,
      status: v.status,
      lastSeen: v.lastSeen,
    });
  }
  // sort online first
  list.sort((a, b) => {
    const rank = (s) => (String(s).includes('off') ? 3 : 0);
    return rank(a.status) - rank(b.status) || a.username.localeCompare(b.username);
  });
  io.emit('online', { online: list });
}

/* ----------------------------- Auth / Sessions ----------------------------- */
function createSession(user, socket) {
  const token = nanoid(32);
  const sess = {
    id: 's_' + nanoid(10),
    token,
    createdAt: now(),
    lastSeen: now(),
    ip: safeIP(socket),
    ua: safeUA(socket),
  };
  if (!Array.isArray(user.sessions)) user.sessions = [];
  user.sessions.push(sess);

  // cap sessions
  if (user.sessions.length > 25) user.sessions.splice(0, user.sessions.length - 25);

  // login history
  if (!Array.isArray(user.loginHistory)) user.loginHistory = [];
  user.loginHistory.push({ ts: now(), ip: sess.ip, ua: sess.ua });
  if (user.loginHistory.length > 60) user.loginHistory.splice(0, user.loginHistory.length - 60);

  user.lastSeen = now();
  return sess;
}

function findSessionByToken(token) {
  if (!token) return null;
  const t = String(token);
  for (const userLower of Object.keys(getDB().users)) {
    const user = getDB().users[userLower];
    if (!user || !Array.isArray(user.sessions)) continue;
    const sess = user.sessions.find(s => s && s.token === t);
    if (sess) return { userLower, user, sess };
  }
  return null;
}

function touchSession(user, token) {
  if (!user || !Array.isArray(user.sessions)) return;
  const sess = user.sessions.find(s => s && s.token === token);
  if (sess) sess.lastSeen = now();
}

/* ----------------------------- Cooldowns ----------------------------- */
function cooldownKey(userLower, channelId) {
  return `${userLower}|${channelId}`;
}

function canSend(userLower, channelId) {
  const key = cooldownKey(userLower, channelId);
  const until = cooldowns.get(key) || 0;
  return now() >= until;
}

function startCooldown(userLower, channelId, ms) {
  const key = cooldownKey(userLower, channelId);
  cooldowns.set(key, now() + ms);
}

function canSendLink(userLower) {
  const until = linkCooldowns.get(userLower) || 0;
  return now() >= until;
}

function startLinkCooldown(userLower) {
  linkCooldowns.set(userLower, now() + LINK_COOLDOWN_MS);
}

/* ----------------------------- Socket API ----------------------------- */
io.on('connection', (socket) => {
  socket.data.authed = false;
  socket.data.userLower = null;
  socket.data.token = null;

  // Helper: require auth
  function requireAuth(cb, ack) {
    if (!socket.data.authed || !socket.data.userLower) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Not authenticated' });
      return;
    }
    return cb();
  }

  function emitBootstrapToSocket() {
    const userLower = socket.data.userLower;
    const user = getUser(userLower);
    const channels = getChannelsForUser(userLower).map(c => channelForClient(c, userLower));
    const online = getOnlineList();

    socket.emit('bootstrap', {
      channels,
      online,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      linkCooldownMs: LINK_COOLDOWN_MS,
      user: user ? getUserPublic(user, onlineStatusForUser(userLower)) : null,
    });
  }

  /* ----------------------------- AUTH ----------------------------- */
  socket.on('auth', async (payload, ack) => {
    try {
      const guest = !!payload?.guest;
      if (guest) {
        // guest sessions are not persisted as real accounts
        const guestName = `guest_${nanoid(5)}`;
        socket.data.authed = true;
        socket.data.userLower = normalizeUsername(guestName);
        socket.data.token = null;

        setUserOnline(socket.data.userLower, socket);
        socketToUser.set(socket.id, socket.data.userLower);

        // join rooms
        joinRoomsForUser(socket, socket.data.userLower);

        emitBootstrapToSocket();
        broadcastOnline();

        if (typeof ack === 'function') {
          ack({
            ok: true,
            token: null,
            isNew: true,
            user: {
              username: guestName,
              createdAt: null,
              lastSeen: now(),
              level: 1,
              badges: [],
              isBeta: false,
              blocked: [],
            },
            blocked: [],
          });
        }
        return;
      }

      const username = String(payload?.username || '').trim();
      const password = String(payload?.password || '').trim();
      if (!validateUsername(username)) return ack?.({ ok: false, error: 'Invalid username (4–20 letters/numbers/_)' });
      if (!validatePassword(password)) return ack?.({ ok: false, error: 'Invalid password (4–32 letters/numbers/_)' });

      const userLower = normalizeUsername(username);
      let user = getUser(userLower);
      let isNew = false;

      if (!user) {
        // create account
        isNew = true;
        const passHash = await bcrypt.hash(password, 10);
        user = {
          username,
          passHash,
          createdAt: now(),
          lastSeen: now(),
          level: 1,
          badges: [],
          isBeta: BETA_MODE,
          blocked: [],
          shadowMutedUntil: 0,
          sessions: [],
          loginHistory: [],
        };
      } else {
        // verify password (prevents username takeover)
        const ok = await bcrypt.compare(password, user.passHash || '');
        if (!ok) return ack?.({ ok: false, error: 'Wrong password' });
        // keep canonical casing for username as stored
      }

      // create session
      const sess = createSession(user, socket);

      // persist
      setUser(userLower, user);

      // mark authed
      socket.data.authed = true;
      socket.data.userLower = userLower;
      socket.data.token = sess.token;

      // presence
      setUserOnline(userLower, socket);
      socketToUser.set(socket.id, userLower);

      // join rooms
      joinRoomsForUser(socket, userLower);

      emitBootstrapToSocket();
      broadcastOnline();

      return ack?.({
        ok: true,
        token: sess.token,
        isNew,
        user: {
          username: user.username,
          createdAt: user.createdAt,
          lastSeen: user.lastSeen,
          level: user.level,
          badges: user.badges || [],
          isBeta: !!user.isBeta,
        },
        blocked: user.blocked || [],
      });
    } catch (e) {
      console.error('auth error', e);
      return ack?.({ ok: false, error: 'Server error' });
    }
  });

  socket.on('resume', (payload, ack) => {
    try {
      const token = String(payload?.token || '');
      const found = findSessionByToken(token);
      if (!found) return ack?.({ ok: false, error: 'Invalid session' });

      const { userLower, user } = found;
      touchSession(user, token);
      user.lastSeen = now();
      setUser(userLower, user);

      socket.data.authed = true;
      socket.data.userLower = userLower;
      socket.data.token = token;

      setUserOnline(userLower, socket);
      socketToUser.set(socket.id, userLower);

      joinRoomsForUser(socket, userLower);

      emitBootstrapToSocket();
      broadcastOnline();

      return ack?.({
        ok: true,
        user: {
          username: user.username,
          createdAt: user.createdAt,
          lastSeen: user.lastSeen,
          level: user.level,
          badges: user.badges || [],
          isBeta: !!user.isBeta,
        },
        blocked: user.blocked || [],
      });
    } catch (e) {
      console.error('resume error', e);
      return ack?.({ ok: false, error: 'Server error' });
    }
  });

  socket.on('logout', (payload, ack) => {
    try {
      const userLower = socket.data.userLower;
      const token = socket.data.token;
      if (userLower && token) {
        const user = getUser(userLower);
        if (user && Array.isArray(user.sessions)) {
          user.sessions = user.sessions.filter(s => s && s.token !== token);
          setUser(userLower, user);
        }
      }
      cleanupSocketAuth(socket);
      ack?.({ ok: true });
    } catch {
      ack?.({ ok: true });
    }
  });

  /* ----------------------------- BOOTSTRAP ----------------------------- */
  socket.on('bootstrap', (payload, ack) => {
    // Client may request via ack; we also push via emit on auth/resume
    try {
      requireAuth(() => {
        emitBootstrapToSocket();
        ack?.({ ok: true });
      }, ack);
    } catch {
      ack?.({ ok: false, error: 'Server error' });
    }
  });

  /* ----------------------------- CHANNEL HISTORY ----------------------------- */
  socket.on('getMessages', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const channelId = String(payload?.channelId || '');
      const limit = clampInt(payload?.limit, 10, 200, 60);

      const chan = getChannel(channelId);
      if (!chan || !canViewChannel(chan, userLower)) return ack?.({ ok: false, error: 'No access' });

      const items = getVisibleHistory(channelId, userLower, limit);
      return ack?.({ ok: true, items });
    }, ack);
  });

  socket.on('viewChannel', (payload) => {
    // optional unread tracking could be added here; client handles local unread
    // no-op for now
  });

  /* ----------------------------- SEND MESSAGE ----------------------------- */
  socket.on('sendMessage', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const user = getUser(userLower);
      const username = user?.username || userLower;

      const channelId = String(payload?.channelId || '');
      const textRaw = String(payload?.text || '');
      const text = textRaw.trim();
      if (!text) return ack?.({ ok: false, error: 'Empty message' });

      const chan = getChannel(channelId);
      if (!chan || !canViewChannel(chan, userLower)) return ack?.({ ok: false, error: 'No access' });

      // muted check (group)
      if (chan.type === 'group') {
        const muted = new Set((chan.muted || []).map(normalizeUsername));
        if (muted.has(userLower)) return ack?.({ ok: false, error: 'You are muted in this group.' });
      }

      // cooldown check
      const cd = Number.isFinite(chan.cooldownMs) ? chan.cooldownMs : DEFAULT_COOLDOWN_MS;
      if (!canSend(userLower, channelId)) {
        return ack?.({ ok: false, error: 'Cooldown active' });
      }

      // URL policy
      const urls = extractUrls(text);
      if (urls.some(isBannedUrl)) {
        return ack?.({ ok: false, error: 'Blocked: 18+ link detected' });
      }
      if (isSpammyUrls(urls)) {
        return ack?.({ ok: false, error: 'Blocked: too many links' });
      }
      if (urls.length > 0) {
        if (!canSendLink(userLower)) {
          return ack?.({ ok: false, error: 'Link cooldown active (1 link / 5 minutes)' });
        }
      }

      // Shadow mute logic: if bad stuff or already shadow-muted, accept but hide from others
      let hiddenForOthers = false;
      const badNow = containsBadStuff(text);
      const mutedUntil = Number(user?.shadowMutedUntil || 0);

      if (badNow) {
        if (user) {
          user.shadowMutedUntil = now() + SHADOW_MUTE_MS;
          setUser(userLower, user);
        }
        hiddenForOthers = true;
      } else if (mutedUntil && now() < mutedUntil) {
        hiddenForOthers = true;
      }

      const msg = {
        id: 'm_' + nanoid(12),
        channelId,
        username,
        text,
        ts: now(),
        hiddenForOthers: !!hiddenForOthers,
      };

      // persist message (we keep hidden ones in history but they won't be served to others)
      pushHistory(channelId, msg);

      // start cooldown after accept
      startCooldown(userLower, channelId, cd);
      if (urls.length > 0) startLinkCooldown(userLower);

      // Broadcast:
      if (hiddenForOthers) {
        // send only to sender (so they think it worked)
        socket.emit('message', msg);
      } else {
        io.to(roomForChannel(channelId)).emit('message', msg);
      }

      return ack?.({ ok: true, message: msg });
    }, ack);
  });

  /* ----------------------------- DISCOVER / JOIN / CREATE GROUPS ----------------------------- */
  socket.on('discoverGroups', (payload, ack) => {
    requireAuth(() => {
      if (!PUBLIC_GROUPS) return ack?.({ ok: true, items: [] });

      const items = listChannels()
        .filter(c => c && c.type === 'group' && c.isPublic)
        .slice(0, 80)
        .map(c => ({
          id: c.id,
          name: c.name,
          membersCount: Array.isArray(c.members) ? c.members.length : 0,
          limit: c.limit || null,
        }));

      return ack?.({ ok: true, items });
    }, ack);
  });

  socket.on('createGroup', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const user = getUser(userLower);
      const owner = user?.username || userLower;

      const name = String(payload?.name || '').trim();
      if (name.length < 2) return ack?.({ ok: false, error: 'Group name too short' });

      const limit = clampInt(payload?.limit, 2, 200, 30);
      const members = Array.isArray(payload?.members) ? payload.members : [];

      const chan = createGroupChannel({
        name,
        owner,
        limit,
        members,
        isPublic: PUBLIC_GROUPS, // default public if discovery enabled
      });

      // join rooms for this socket now
      socket.join(roomForChannel(chan.id));

      // notify members (inbox notifications)
      notifyMembersInvite(chan, owner);

      // broadcast channels list update to affected users
      broadcastChannelsToUsers(chan.members);

      return ack?.({ ok: true, channel: channelForClient(chan, userLower), group: sanitizeGroup(chan) });
    }, ack);
  });

  socket.on('joinGroup', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const user = getUser(userLower);
      const username = user?.username || userLower;

      const groupId = String(payload?.groupId || '');
      const chan = getChannel(groupId);
      if (!chan || chan.type !== 'group' || !chan.isPublic) return ack?.({ ok: false, error: 'Group not found' });

      if (!Array.isArray(chan.members)) chan.members = [];
      const already = chan.members.some(m => normalizeUsername(m) === userLower);
      if (already) return ack?.({ ok: true, channel: channelForClient(chan, userLower) });

      if (Number.isFinite(chan.limit) && chan.members.length >= chan.limit) {
        return ack?.({ ok: false, error: 'Group is full' });
      }

      chan.members.push(username);
      setChannel(chan.id, chan);

      socket.join(roomForChannel(chan.id));
      broadcastChannelsToUsers(chan.members);

      return ack?.({ ok: true, channel: channelForClient(chan, userLower) });
    }, ack);
  });

  /* ----------------------------- GROUP MANAGEMENT ----------------------------- */
  socket.on('getGroup', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const channelId = String(payload?.channelId || '');
      const chan = getChannel(channelId);
      if (!chan || chan.type !== 'group') return ack?.({ ok: false, error: 'Not a group' });
      if (!canViewChannel(chan, userLower)) return ack?.({ ok: false, error: 'No access' });

      return ack?.({ ok: true, group: sanitizeGroup(chan) });
    }, ack);
  });

  socket.on('setGroupLimit', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const channelId = String(payload?.channelId || '');
      const limit = clampInt(payload?.limit, 2, 200, 30);
      const chan = getChannel(channelId);
      if (!chan || chan.type !== 'group') return ack?.({ ok: false, error: 'Not a group' });
      if (!canViewChannel(chan, userLower)) return ack?.({ ok: false, error: 'No access' });
      if (normalizeUsername(chan.owner) !== userLower) return ack?.({ ok: false, error: 'Owner only' });

      const current = Number.isFinite(chan.limit) ? chan.limit : 30;
      if (limit > current) return ack?.({ ok: false, error: 'Limit can only be lowered' });
      if (Array.isArray(chan.members) && chan.members.length > limit) {
        return ack?.({ ok: false, error: 'Limit is below current member count' });
      }

      chan.limit = limit;
      setChannel(chan.id, chan);

      io.to(roomForChannel(chan.id)).emit('groupUpdated', channelForClient(chan, null));
      broadcastChannelsToUsers(chan.members);

      return ack?.({ ok: true });
    }, ack);
  });

  socket.on('addGroupMember', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const channelId = String(payload?.channelId || '');
      const username = String(payload?.username || '').trim();
      if (!validateUsername(username)) return ack?.({ ok: false, error: 'Invalid username' });

      const targetLower = normalizeUsername(username);
      const target = getUser(targetLower);
      if (!target) return ack?.({ ok: false, error: 'User not found' });

      const chan = getChannel(channelId);
      if (!chan || chan.type !== 'group') return ack?.({ ok: false, error: 'Not a group' });
      if (!canViewChannel(chan, userLower)) return ack?.({ ok: false, error: 'No access' });
      if (normalizeUsername(chan.owner) !== userLower) return ack?.({ ok: false, error: 'Owner only' });

      if (!Array.isArray(chan.members)) chan.members = [];
      if (chan.members.some(m => normalizeUsername(m) === targetLower)) return ack?.({ ok: true });

      if (Number.isFinite(chan.limit) && chan.members.length >= chan.limit) {
        return ack?.({ ok: false, error: 'Group is full' });
      }

      chan.members.push(target.username);
      setChannel(chan.id, chan);

      // notify invite
      notifyMembersInvite(chan, chan.owner);

      broadcastChannelsToUsers(chan.members);

      return ack?.({ ok: true });
    }, ack);
  });

  socket.on('removeGroupMember', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const channelId = String(payload?.channelId || '');
      const username = String(payload?.username || '').trim();
      const targetLower = normalizeUsername(username);

      const chan = getChannel(channelId);
      if (!chan || chan.type !== 'group') return ack?.({ ok: false, error: 'Not a group' });
      if (!canViewChannel(chan, userLower)) return ack?.({ ok: false, error: 'No access' });
      if (normalizeUsername(chan.owner) !== userLower) return ack?.({ ok: false, error: 'Owner only' });

      // cannot remove owner
      if (normalizeUsername(chan.owner) === targetLower) return ack?.({ ok: false, error: 'Cannot remove owner' });

      chan.members = (chan.members || []).filter(m => normalizeUsername(m) !== targetLower);
      chan.muted = (chan.muted || []).filter(m => normalizeUsername(m) !== targetLower);

      setChannel(chan.id, chan);

      // kick sockets of removed user from room
      kickUserFromChannel(targetLower, chan.id);

      broadcastChannelsToUsers(chan.members.concat([username]));
      io.to(roomForChannel(chan.id)).emit('groupUpdated', channelForClient(chan, null));

      return ack?.({ ok: true });
    }, ack);
  });

  socket.on('transferGroupOwnership', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const channelId = String(payload?.channelId || '');
      const username = String(payload?.username || '').trim();
      const targetLower = normalizeUsername(username);

      const chan = getChannel(channelId);
      if (!chan || chan.type !== 'group') return ack?.({ ok: false, error: 'Not a group' });
      if (!canViewChannel(chan, userLower)) return ack?.({ ok: false, error: 'No access' });
      if (normalizeUsername(chan.owner) !== userLower) return ack?.({ ok: false, error: 'Owner only' });

      if (!Array.isArray(chan.members) || !chan.members.some(m => normalizeUsername(m) === targetLower)) {
        return ack?.({ ok: false, error: 'Target is not a member' });
      }

      // transfer
      const target = getUser(targetLower);
      if (!target) return ack?.({ ok: false, error: 'User not found' });

      chan.owner = target.username;
      setChannel(chan.id, chan);

      io.to(roomForChannel(chan.id)).emit('groupUpdated', channelForClient(chan, null));
      broadcastChannelsToUsers(chan.members);

      return ack?.({ ok: true });
    }, ack);
  });

  socket.on('muteGroupMember', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const channelId = String(payload?.channelId || '');
      const username = String(payload?.username || '').trim();
      const targetLower = normalizeUsername(username);

      const chan = getChannel(channelId);
      if (!chan || chan.type !== 'group') return ack?.({ ok: false, error: 'Not a group' });
      if (!canViewChannel(chan, userLower)) return ack?.({ ok: false, error: 'No access' });
      if (normalizeUsername(chan.owner) !== userLower) return ack?.({ ok: false, error: 'Owner only' });

      if (normalizeUsername(chan.owner) === targetLower) return ack?.({ ok: false, error: 'Cannot mute owner' });

      chan.muted = Array.isArray(chan.muted) ? chan.muted : [];
      if (!chan.muted.some(m => normalizeUsername(m) === targetLower)) chan.muted.push(username);
      setChannel(chan.id, chan);

      io.to(roomForChannel(chan.id)).emit('groupUpdated', channelForClient(chan, null));
      broadcastChannelsToUsers(chan.members);

      return ack?.({ ok: true });
    }, ack);
  });

  socket.on('unmuteGroupMember', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const channelId = String(payload?.channelId || '');
      const username = String(payload?.username || '').trim();
      const targetLower = normalizeUsername(username);

      const chan = getChannel(channelId);
      if (!chan || chan.type !== 'group') return ack?.({ ok: false, error: 'Not a group' });
      if (!canViewChannel(chan, userLower)) return ack?.({ ok: false, error: 'No access' });
      if (normalizeUsername(chan.owner) !== userLower) return ack?.({ ok: false, error: 'Owner only' });

      chan.muted = (chan.muted || []).filter(m => normalizeUsername(m) !== targetLower);
      setChannel(chan.id, chan);

      io.to(roomForChannel(chan.id)).emit('groupUpdated', channelForClient(chan, null));
      broadcastChannelsToUsers(chan.members);

      return ack?.({ ok: true });
    }, ack);
  });

  /* ----------------------------- DMs ----------------------------- */
  socket.on('openDM', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const user = getUser(userLower);
      const me = user?.username || userLower;

      const targetName = String(payload?.username || '').trim();
      if (!validateUsername(targetName)) return ack?.({ ok: false, error: 'Invalid username' });

      const targetLower = normalizeUsername(targetName);
      const target = getUser(targetLower);
      if (!target) return ack?.({ ok: false, error: 'User not found' });

      if (targetLower === userLower) return ack?.({ ok: false, error: 'Cannot DM yourself' });

      const dm = findOrCreateDM(me, target.username);
      setChannel(dm.id, dm);

      socket.join(roomForChannel(dm.id));
      // also join target's sockets to room when they connect; that's handled by joinRoomsForUser

      broadcastChannelsToUsers(dm.members);

      return ack?.({ ok: true, channel: channelForClient(dm, userLower) });
    }, ack);
  });

  /* ----------------------------- PROFILE / BLOCKS ----------------------------- */
  socket.on('getProfile', (payload, ack) => {
    requireAuth(() => {
      const username = String(payload?.username || '').trim();
      if (!validateUsername(username)) return ack?.({ ok: false, error: 'Invalid username' });
      const u = getUser(normalizeUsername(username));
      if (!u) return ack?.({ ok: false, error: 'User not found' });

      const status = onlineStatusForUser(normalizeUsername(username));
      return ack?.({ ok: true, profile: getUserPublic(u, status) });
    }, ack);
  });

  socket.on('blockUser', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const target = String(payload?.username || '').trim();
      if (!validateUsername(target)) return ack?.({ ok: false, error: 'Invalid username' });

      const u = getUser(userLower);
      if (!u) return ack?.({ ok: false, error: 'User missing' });

      const tL = normalizeUsername(target);
      if (tL === userLower) return ack?.({ ok: false, error: 'Cannot block yourself' });

      u.blocked = Array.isArray(u.blocked) ? u.blocked : [];
      if (!u.blocked.some(x => normalizeUsername(x) === tL)) u.blocked.push(target);
      setUser(userLower, u);

      return ack?.({ ok: true, blocked: u.blocked });
    }, ack);
  });

  socket.on('unblockUser', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const target = String(payload?.username || '').trim();
      if (!validateUsername(target)) return ack?.({ ok: false, error: 'Invalid username' });

      const u = getUser(userLower);
      if (!u) return ack?.({ ok: false, error: 'User missing' });

      const tL = normalizeUsername(target);
      u.blocked = (u.blocked || []).filter(x => normalizeUsername(x) !== tL);
      setUser(userLower, u);

      return ack?.({ ok: true, blocked: u.blocked });
    }, ack);
  });

  /* ----------------------------- SECURITY ANALYTICS ----------------------------- */
  socket.on('getLoginHistory', (payload, ack) => {
    requireAuth(() => {
      const user = getUser(socket.data.userLower);
      const items = (user?.loginHistory || []).slice().reverse().slice(0, 25);
      return ack?.({ ok: true, items });
    }, ack);
  });

  socket.on('getSessions', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const user = getUser(userLower);
      const token = socket.data.token;

      const items = (user?.sessions || []).slice().reverse().slice(0, 25).map(s => ({
        id: s.id,
        label: s.createdAt ? `Session • ${new Date(s.createdAt).toISOString().slice(0, 10)}` : 'Session',
        ip: s.ip || '—',
        ua: s.ua || '—',
        current: token && s.token === token,
      }));

      return ack?.({ ok: true, items });
    }, ack);
  });

  socket.on('revokeSession', (payload, ack) => {
    requireAuth(() => {
      const userLower = socket.data.userLower;
      const user = getUser(userLower);
      const sessionId = String(payload?.sessionId || '');
      if (!user) return ack?.({ ok: false, error: 'User missing' });

      user.sessions = (user.sessions || []).filter(s => s && s.id !== sessionId);
      setUser(userLower, user);

      // If they revoked their current session, also disconnect
      const myToken = socket.data.token;
      const stillHas = (user.sessions || []).some(s => s && s.token === myToken);
      if (!stillHas) {
        try { socket.disconnect(true); } catch {}
      }

      return ack?.({ ok: true });
    }, ack);
  });

  socket.on('changePassword', async (payload, ack) => {
    requireAuth(async () => {
      const userLower = socket.data.userLower;
      const user = getUser(userLower);
      if (!user) return ack?.({ ok: false, error: 'User missing' });

      const currentPassword = String(payload?.currentPassword || '');
      const newPassword = String(payload?.newPassword || '');
      if (!validatePassword(newPassword)) return ack?.({ ok: false, error: 'Invalid new password' });

      const ok = await bcrypt.compare(currentPassword, user.passHash || '');
      if (!ok) return ack?.({ ok: false, error: 'Wrong current password' });

      user.passHash = await bcrypt.hash(newPassword, 10);
      setUser(userLower, user);

      return ack?.({ ok: true });
    }, ack);
  });

  socket.on('changeUsername', async (payload, ack) => {
    requireAuth(async () => {
      const userLower = socket.data.userLower;
      const user = getUser(userLower);
      if (!user) return ack?.({ ok: false, error: 'User missing' });

      const password = String(payload?.password || '');
      const newUsername = String(payload?.newUsername || '').trim();

      if (!validateUsername(newUsername)) return ack?.({ ok: false, error: 'Invalid new username' });

      const ok = await bcrypt.compare(password, user.passHash || '');
      if (!ok) return ack?.({ ok: false, error: 'Wrong password' });

      const newLower = normalizeUsername(newUsername);
      if (getUser(newLower)) return ack?.({ ok: false, error: 'Username already taken' });

      // Update user record
      const oldUsername = user.username;
      user.username = newUsername;

      // Move user key
      delUser(userLower);
      setUser(newLower, user);

      // Update channels (members / owner / muted / dm members)
      for (const c of listChannels()) {
        if (!c || !Array.isArray(c.members)) continue;
        let changed = false;

        c.members = c.members.map(m => {
          if (normalizeUsername(m) === userLower) {
            changed = true;
            return newUsername;
          }
          return m;
        });

        if (c.owner && normalizeUsername(c.owner) === userLower) {
          c.owner = newUsername;
          changed = true;
        }

        if (Array.isArray(c.muted)) {
          c.muted = c.muted.map(m => (normalizeUsername(m) === userLower ? newUsername : m));
        }

        if (changed) setChannel(c.id, c);
      }

      // Update presence maps
      const entry = onlineUsers.get(userLower);
      if (entry) {
        onlineUsers.delete(userLower);
        onlineUsers.set(newLower, entry);
        entry.username = newUsername;
      }

      // Update socket auth in-memory
      socket.data.userLower = newLower;
      socketToUser.set(socket.id, newLower);

      // Refresh rooms (simpler to just re-join all)
      joinRoomsForUser(socket, newLower);

      broadcastOnline();

      return ack?.({ ok: true });
    }, ack);
  });

  /* ----------------------------- DISCONNECT ----------------------------- */
  socket.on('disconnect', () => {
    cleanupSocketAuth(socket);
  });
});

/* ----------------------------- Room helpers ----------------------------- */
function roomForChannel(channelId) {
  return `chan:${channelId}`;
}

function joinRoomsForUser(socket, userLower) {
  // Always join global
  socket.join(roomForChannel('global'));

  // Join all channels the user can view
  const chans = getChannelsForUser(userLower);
  for (const c of chans) {
    socket.join(roomForChannel(c.id));
  }
}

function getChannelsForUser(userLower) {
  const chans = [];
  const all = listChannels();

  for (const c of all) {
    if (!c) continue;
    if (c.type === 'global') {
      chans.push(c);
      continue;
    }
    if (canViewChannel(c, userLower)) chans.push(c);
  }

  // stable ordering: global first then activity
  chans.sort((a, b) => {
    if (a.id === 'global') return -1;
    if (b.id === 'global') return 1;
    return (b.lastActivity || 0) - (a.lastActivity || 0);
  });

  return chans;
}

function sanitizeGroup(chan) {
  return {
    id: chan.id,
    name: chan.name,
    owner: chan.owner,
    members: Array.isArray(chan.members) ? chan.members.slice() : [],
    membersCount: Array.isArray(chan.members) ? chan.members.length : 0,
    limit: Number.isFinite(chan.limit) ? chan.limit : null,
    muted: Array.isArray(chan.muted) ? chan.muted.slice() : [],
    isPublic: !!chan.isPublic,
  };
}

function notifyMembersInvite(groupChan, inviter) {
  // inbox notifications via socket event "systemNotification"
  const members = Array.isArray(groupChan.members) ? groupChan.members : [];
  for (const m of members) {
    const mL = normalizeUsername(m);
    // try to notify online sockets
    for (const [sid, uL] of socketToUser.entries()) {
      if (uL !== mL) continue;
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      s.emit('systemNotification', {
        type: 'group',
        title: `Group update: ${groupChan.name}`,
        body: `You were added to a group by ${inviter}.`,
        ts: now(),
        meta: { channelId: groupChan.id },
      });
    }
  }
}

function broadcastChannelsToUsers(usernames) {
  // send updated channel list to the users in `usernames`
  const lowers = new Set((usernames || []).map(normalizeUsername));
  for (const [sid, uL] of socketToUser.entries()) {
    if (!lowers.has(uL)) continue;
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    const channels = getChannelsForUser(uL).map(c => channelForClient(c, uL));
    s.emit('channels', { channels });
  }
}

function kickUserFromChannel(targetLower, channelId) {
  for (const [sid, uL] of socketToUser.entries()) {
    if (uL !== targetLower) continue;
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    try { s.leave(roomForChannel(channelId)); } catch {}
  }
}

/* ----------------------------- Online list utils ----------------------------- */
function getOnlineList() {
  const list = [];
  for (const [, v] of onlineUsers.entries()) {
    list.push({ username: v.username, status: v.status, lastSeen: v.lastSeen });
  }
  list.sort((a, b) => {
    const rank = (s) => (String(s).includes('off') ? 3 : 0);
    return rank(a.status) - rank(b.status) || a.username.localeCompare(b.username);
  });
  return list;
}

function onlineStatusForUser(userLower) {
  const entry = onlineUsers.get(userLower);
  if (!entry) return 'offline';
  return entry.status || 'offline';
}

/* ----------------------------- Cleanup ----------------------------- */
function cleanupSocketAuth(socket) {
  const userLower = socketToUser.get(socket.id) || socket.data.userLower;
  socketToUser.delete(socket.id);

  if (userLower) {
    const entry = onlineUsers.get(userLower);
    if (entry && entry.sockets) {
      entry.sockets.delete(socket.id);
      if (entry.sockets.size === 0) {
        entry.status = 'offline';
        entry.lastSeen = now();
      }
    }

    // persist lastSeen for real accounts
    const user = getUser(userLower);
    if (user) {
      user.lastSeen = now();
      setUser(userLower, user);
    }
  }

  socket.data.authed = false;
  socket.data.userLower = null;
  socket.data.token = null;

  broadcastOnline();
}

/* ----------------------------- Start ----------------------------- */
server.listen(PORT, () => {
  console.log(`tonkotsu.online server listening on :${PORT}`);
});

/* ----------------------------- DB init helpers ----------------------------- */
function initDB() {
  const cur = getDB();
  if (!cur.version) cur.version = 1;
  if (!cur.users) cur.users = {};
  if (!cur.channels) cur.channels = {};

  if (!cur.channels.global) {
    cur.channels.global = {
      id: 'global',
      type: 'global',
      name: 'global',
      owner: null,
      members: [],
      limit: null,
      muted: [],
      isPublic: true,
      cooldownMs: DEFAULT_COOLDOWN_MS,
      lastActivity: now(),
      history: [],
    };
  }

  // Clean any malformed data minimally
  for (const [k, u] of Object.entries(cur.users)) {
    if (!u || typeof u !== 'object') {
      delete cur.users[k];
      continue;
    }
    u.username = String(u.username || k);
    u.createdAt = Number(u.createdAt || now());
    u.lastSeen = Number(u.lastSeen || now());
    u.level = Number.isFinite(u.level) ? u.level : 1;
    u.badges = Array.isArray(u.badges) ? u.badges : [];
    u.blocked = Array.isArray(u.blocked) ? u.blocked : [];
    u.shadowMutedUntil = Number(u.shadowMutedUntil || 0);
    u.sessions = Array.isArray(u.sessions) ? u.sessions : [];
    u.loginHistory = Array.isArray(u.loginHistory) ? u.loginHistory : [];
  }

  for (const [id, c] of Object.entries(cur.channels)) {
    if (!c || typeof c !== 'object') {
      delete cur.channels[id];
      continue;
    }
    c.id = String(c.id || id);
    c.type = String(c.type || 'group');
    c.name = String(c.name || c.id);
    c.members = Array.isArray(c.members) ? c.members : [];
    c.muted = Array.isArray(c.muted) ? c.muted : [];
    c.limit = Number.isFinite(c.limit) ? c.limit : (c.type === 'group' ? 30 : null);
    c.cooldownMs = Number.isFinite(c.cooldownMs) ? c.cooldownMs : DEFAULT_COOLDOWN_MS;
    c.isPublic = !!c.isPublic;
    c.lastActivity = Number.isFinite(c.lastActivity) ? c.lastActivity : 0;
    c.history = Array.isArray(c.history) ? c.history : [];
    if (c.history.length > MAX_HISTORY_PER_CHANNEL) {
      c.history = c.history.slice(-MAX_HISTORY_PER_CHANNEL);
    }
  }

  saveDB();
}

