'use strict';

/**
 * tonkotsu.online
 * server.js (Node ONLY): Express + Socket.IO + API
 * - No window / DOM references here.
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Optional: comma-separated usernames that get special badges.
const BETA_USERS = new Set((process.env.BETA_USERS || '').split(',').map(s => s.trim()).filter(Boolean));
const EARLY_ACCESS_USERS = new Set((process.env.EARLY_ACCESS_USERS || '').split(',').map(s => s.trim()).filter(Boolean));
const ANNOUNCEMENT_USERS = new Set((process.env.ANNOUNCEMENT_USERS || '').split(',').map(s => s.trim()).filter(Boolean));

// Rate / cooldown (ms)
const COOLDOWN_GUEST_GLOBAL = 5000;
const COOLDOWN_USER_GLOBAL = 3000;

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const p = path.join(DATA_DIR, file);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

const db = {
  users: readJson('users.json', []),           // [{id, username, passHash, bio, statusText, presence, badges, friends:[], createdAt}]
  threads: readJson('threads.json', []),       // [{id, type:'global'|'dm'|'group', name, members:[userId], createdBy, createdAt}]
  messages: readJson('messages.json', []),     // [{id, threadId, senderId, senderName, content, createdAt, editedAt, type, clientId}]
};

function persist() {
  writeJson('users.json', db.users);
  writeJson('threads.json', db.threads);
  writeJson('messages.json', db.messages);
}

// Ensure global thread exists
function ensureGlobalThread() {
  let t = db.threads.find(x => x.type === 'global');
  if (!t) {
    t = { id: 'global', type: 'global', name: 'Global', members: [], createdBy: null, createdAt: Date.now() };
    db.threads.unshift(t);
    persist();
  }
}
ensureGlobalThread();

function uid(prefix='') {
  return prefix + crypto.randomBytes(12).toString('hex');
}

function sanitizeUsername(name) {
  const s = (name || '').trim();
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(s)) return null;
  return s;
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function getUserPublic(u) {
  return {
    id: u.id,
    username: u.username,
    bio: u.bio || '',
    statusText: u.statusText || '',
    presence: u.presence || 'online', // online|idle|dnd|invisible
    badges: Array.isArray(u.badges) ? u.badges : [],
    isGuest: !!u.isGuest,
    createdAt: u.createdAt,
  };
}

function ensureBadges(user) {
  const set = new Set(user.badges || []);
  if (user.isGuest) set.add('GUEST');
  if (BETA_USERS.has(user.username)) set.add('BETA');
  if (EARLY_ACCESS_USERS.has(user.username)) set.add('EARLY ACCESS');
  if (ANNOUNCEMENT_USERS.has(user.username)) set.add('ANNOUNCEMENT');
  user.badges = Array.from(set);
}

function findUserById(id) {
  return db.users.find(u => u.id === id);
}

function findUserByName(username) {
  return db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
}

function authMiddleware(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  const decoded = token ? verifyToken(token) : null;
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });
  const user = findUserById(decoded.id);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  ensureBadges(user);
  req.user = user;
  next();
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR));

// --------- API ---------

app.post('/api/register', async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = (req.body.password || '').toString();
  if (!username) return res.status(400).json({ error: 'Username must be 2-20 chars: letters, numbers, underscore.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (findUserByName(username)) return res.status(409).json({ error: 'Username already taken.' });

  const passHash = await bcrypt.hash(password, 10);
  const user = {
    id: uid('u_'),
    username,
    passHash,
    bio: '',
    statusText: '',
    presence: 'online',
    badges: [],
    friends: [],
    isGuest: false,
    createdAt: Date.now(),
  };
  // Default badge for new users (optional): BETA
  user.badges.push('BETA');
  ensureBadges(user);

  db.users.push(user);
  persist();

  const token = signToken({ id: user.id });
  res.json({ token, user: getUserPublic(user) });
});

app.post('/api/login', async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = (req.body.password || '').toString();
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials.' });
  const user = findUserByName(username);
  if (!user || user.isGuest) return res.status(401).json({ error: 'Invalid credentials.' });
  const ok = await bcrypt.compare(password, user.passHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials.' });

  ensureBadges(user);
  persist();
  const token = signToken({ id: user.id });
  res.json({ token, user: getUserPublic(user) });
});

app.post('/api/guest', (req, res) => {
  // Guests are ephemeral but we still store them so presence + DMs rules can apply.
  const base = 'guest' + Math.floor(Math.random() * 10000);
  let username = base;
  let i = 0;
  while (findUserByName(username)) {
    i++;
    username = base + '_' + i;
  }
  const user = {
    id: uid('g_'),
    username,
    passHash: null,
    bio: '',
    statusText: '',
    presence: 'online',
    badges: ['GUEST'],
    friends: [],
    isGuest: true,
    createdAt: Date.now(),
  };
  ensureBadges(user);
  db.users.push(user);
  persist();

  const token = signToken({ id: user.id });
  res.json({ token, user: getUserPublic(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ user: getUserPublic(req.user) });
});

app.post('/api/me/profile', authMiddleware, (req, res) => {
  const bio = (req.body.bio || '').toString().slice(0, 240);
  const statusText = (req.body.statusText || '').toString().slice(0, 64);
  const presence = (req.body.presence || '').toString();
  const validPresence = new Set(['online', 'idle', 'dnd', 'invisible']);

  req.user.bio = bio;
  req.user.statusText = statusText;
  if (validPresence.has(presence)) req.user.presence = presence;

  ensureBadges(req.user);
  persist();

  // Broadcast presence/profile change
  io.emit('presence:update', { user: getUserPublic(req.user) });

  res.json({ user: getUserPublic(req.user) });
});

app.get('/api/users/search', authMiddleware, (req, res) => {
  const q = (req.query.q || '').toString().trim().toLowerCase();
  if (!q) return res.json({ users: [] });
  const out = db.users
    .filter(u => !u.isGuest)
    .filter(u => u.username.toLowerCase().includes(q))
    .slice(0, 10)
    .map(getUserPublic);
  res.json({ users: out });
});

app.post('/api/friends/add', authMiddleware, (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: 'Guests cannot add friends.' });
  const targetName = (req.body.username || '').toString().trim();
  const target = findUserByName(targetName);
  if (!target || target.isGuest) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself.' });

  req.user.friends = Array.isArray(req.user.friends) ? req.user.friends : [];
  target.friends = Array.isArray(target.friends) ? target.friends : [];

  if (!req.user.friends.includes(target.id)) req.user.friends.push(target.id);
  if (!target.friends.includes(req.user.id)) target.friends.push(req.user.id);

  persist();
  res.json({ ok: true });
});

app.get('/api/threads', authMiddleware, (req, res) => {
  const myId = req.user.id;

  // Members for global is everyone; for dm/group it is stored.
  const threads = db.threads
    .filter(t => t.type === 'global' || (Array.isArray(t.members) && t.members.includes(myId)))
    .map(t => {
      if (t.type === 'dm') {
        const otherId = t.members.find(x => x !== myId);
        const other = otherId ? findUserById(otherId) : null;
        return {
          id: t.id,
          type: t.type,
          name: other ? other.username : 'DM',
          members: t.members,
          createdAt: t.createdAt,
        };
      }
      return {
        id: t.id,
        type: t.type,
        name: t.name,
        members: t.members || [],
        createdAt: t.createdAt,
      };
    });

  res.json({ threads });
});

app.post('/api/threads/dm', authMiddleware, (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: 'Guests cannot DM.' });
  const targetName = (req.body.username || '').toString().trim();
  const target = findUserByName(targetName);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot DM yourself.' });

  // Find existing dm
  let t = db.threads.find(x =>
    x.type === 'dm' &&
    Array.isArray(x.members) &&
    x.members.length === 2 &&
    x.members.includes(req.user.id) &&
    x.members.includes(target.id)
  );
  if (!t) {
    t = { id: uid('t_'), type: 'dm', name: '', members: [req.user.id, target.id], createdBy: req.user.id, createdAt: Date.now() };
    db.threads.push(t);
    persist();
  }

  res.json({ threadId: t.id });
});

app.post('/api/threads/group', authMiddleware, (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: 'Guests cannot create groups.' });
  const name = (req.body.name || '').toString().trim().slice(0, 40);
  const members = Array.isArray(req.body.members) ? req.body.members : [];
  const memberIds = Array.from(new Set([req.user.id, ...members])).slice(0, 25);

  const validMembers = memberIds
    .map(id => findUserById(id))
    .filter(Boolean)
    .filter(u => !u.isGuest) // guests can't be in groups
    .map(u => u.id);

  if (!name) return res.status(400).json({ error: 'Group name required.' });
  if (validMembers.length < 2) return res.status(400).json({ error: 'Need at least 2 registered members.' });

  const t = { id: uid('t_'), type: 'group', name, members: validMembers, createdBy: req.user.id, createdAt: Date.now() };
  db.threads.push(t);
  persist();

  res.json({ threadId: t.id });
});

app.get('/api/messages', authMiddleware, (req, res) => {
  const threadId = (req.query.threadId || '').toString();
  if (!threadId) return res.status(400).json({ error: 'threadId required.' });

  const thread = db.threads.find(t => t.id === threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });

  const myId = req.user.id;
  const allowed =
    thread.type === 'global' ||
    (Array.isArray(thread.members) && thread.members.includes(myId));

  if (!allowed) return res.status(403).json({ error: 'Forbidden.' });

  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '80', 10) || 80));
  const before = parseInt(req.query.before || '0', 10) || 0;

  let msgs = db.messages.filter(m => m.threadId === threadId);
  msgs.sort((a, b) => a.createdAt - b.createdAt);
  if (before > 0) msgs = msgs.filter(m => m.createdAt < before);

  msgs = msgs.slice(-limit);

  res.json({ messages: msgs });
});

app.post('/api/announce', authMiddleware, (req, res) => {
  // Send an announcement into global as special message.
  ensureBadges(req.user);
  if (req.user.isGuest) return res.status(403).json({ error: 'Guests cannot announce.' });
  if (!req.user.badges.includes('ANNOUNCEMENT')) return res.status(403).json({ error: 'Missing ANNOUNCEMENT badge.' });

  const content = (req.body.content || '').toString().trim().slice(0, 1500);
  if (!content) return res.status(400).json({ error: 'Empty announcement.' });

  const msg = makeMessage({
    threadId: 'global',
    sender: req.user,
    content,
    type: 'announcement',
    clientId: null,
  });
  db.messages.push(msg);
  persist();
  io.to('thread:global').emit('message:new', { message: msg });

  res.json({ ok: true });
});

// --------- Socket.IO ---------

const httpServer = require('http').createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// In-memory presence map (socketId -> userId) and user status.
const socketsByUser = new Map(); // userId -> Set(socketId)
const onlineUsers = new Map(); // userId -> { lastSeen, presence }

function getOnlinePublicList() {
  const out = [];
  for (const [uid, info] of onlineUsers.entries()) {
    const u = findUserById(uid);
    if (!u) continue;
    ensureBadges(u);
    out.push({
      user: getUserPublic(u),
      lastSeen: info.lastSeen,
    });
  }
  // Sort: online > idle > dnd > invisible, then username
  const rank = { online: 0, idle: 1, dnd: 2, invisible: 3 };
  out.sort((a, b) => {
    const ra = rank[a.user.presence] ?? 9;
    const rb = rank[b.user.presence] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.user.username.localeCompare(b.user.username);
  });
  return out;
}

function makeMessage({ threadId, sender, content, type, clientId }) {
  const now = Date.now();
  return {
    id: uid('m_'),
    threadId,
    senderId: sender.id,
    senderName: sender.username,
    content,
    type: type || 'message', // message|announcement
    clientId: clientId || null,
    createdAt: now,
    editedAt: null,
    deletedAt: null
  };
}

function threadAllowed(threadId, userId) {
  if (threadId === 'global') return true;
  const t = db.threads.find(x => x.id === threadId);
  if (!t) return false;
  if (t.type === 'global') return true;
  return Array.isArray(t.members) && t.members.includes(userId);
}

// Dedup key: (senderId + clientId)
const recentClientIds = new Map(); // key -> timestamp
function isDuplicate(senderId, clientId) {
  if (!clientId) return false;
  const key = senderId + '|' + clientId;
  const now = Date.now();
  // prune
  for (const [k, ts] of recentClientIds.entries()) {
    if (now - ts > 5 * 60 * 1000) recentClientIds.delete(k);
  }
  if (recentClientIds.has(key)) return true;
  recentClientIds.set(key, now);
  return false;
}

// Per-user cooldown timestamps
const lastGlobalSend = new Map(); // userId -> ms

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const decoded = token ? verifyToken(token) : null;
  if (!decoded) return next(new Error('unauthorized'));
  const user = findUserById(decoded.id);
  if (!user) return next(new Error('unauthorized'));
  ensureBadges(user);
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.user;

  // Register socket
  if (!socketsByUser.has(user.id)) socketsByUser.set(user.id, new Set());
  socketsByUser.get(user.id).add(socket.id);

  // Set online
  onlineUsers.set(user.id, { lastSeen: Date.now(), presence: user.presence });
  io.emit('presence:list', { users: getOnlinePublicList() });

  socket.on('disconnect', () => {
    const set = socketsByUser.get(user.id);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) socketsByUser.delete(user.id);
    }
    // If no sockets remain, mark offline (remove from online list)
    if (!socketsByUser.has(user.id)) {
      onlineUsers.delete(user.id);
      io.emit('presence:list', { users: getOnlinePublicList() });
    }
  });

  // Join a thread room
  socket.on('thread:join', (payload, cb) => {
    try {
      const threadId = (payload && payload.threadId) ? String(payload.threadId) : '';
      if (!threadId) throw new Error('threadId required');
      if (!threadAllowed(threadId, user.id)) throw new Error('forbidden');
      socket.join('thread:' + threadId);
      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ ok: false, error: e.message || 'error' });
    }
  });

  socket.on('thread:leave', (payload, cb) => {
    const threadId = (payload && payload.threadId) ? String(payload.threadId) : '';
    if (threadId) socket.leave('thread:' + threadId);
    cb && cb({ ok: true });
  });

  socket.on('presence:set', (payload, cb) => {
    const presence = (payload && payload.presence) ? String(payload.presence) : '';
    const valid = new Set(['online', 'idle', 'dnd', 'invisible']);
    if (valid.has(presence)) {
      user.presence = presence;
      persist();
      onlineUsers.set(user.id, { lastSeen: Date.now(), presence: user.presence });
      io.emit('presence:update', { user: getUserPublic(user) });
      io.emit('presence:list', { users: getOnlinePublicList() });
    }
    cb && cb({ ok: true });
  });

  // Send message
  socket.on('message:send', (payload, cb) => {
    try {
      const threadId = String(payload.threadId || '');
      const content = String(payload.content || '').trim();
      const clientId = payload.clientId ? String(payload.clientId) : null;

      if (!threadId) throw new Error('threadId required');
      if (!content) throw new Error('Empty message');
      if (content.length > 1500) throw new Error('Message too long');
      if (!threadAllowed(threadId, user.id)) throw new Error('Forbidden');
      if (isDuplicate(user.id, clientId)) {
        // Reply with existing-ish ack
        cb && cb({ ok: true, duplicate: true });
        return;
      }

      // Guest rules
      if (user.isGuest && threadId !== 'global') throw new Error('Guests cannot DM or join groups.');

      // Cooldown only on global
      if (threadId === 'global') {
        const now = Date.now();
        const last = lastGlobalSend.get(user.id) || 0;
        const cd = user.isGuest ? COOLDOWN_GUEST_GLOBAL : COOLDOWN_USER_GLOBAL;
        const remaining = cd - (now - last);
        if (remaining > 0) throw new Error('Cooldown:' + remaining);
        lastGlobalSend.set(user.id, now);
      }

      const msg = makeMessage({ threadId, sender: user, content, type: 'message', clientId });
      db.messages.push(msg);
      persist();

      io.to('thread:' + threadId).emit('message:new', { message: msg });

      cb && cb({ ok: true, message: msg });
    } catch (e) {
      cb && cb({ ok: false, error: e.message || 'error' });
    }
  });

  // Edit message (within 60s)
  socket.on('message:edit', (payload, cb) => {
    try {
      const messageId = String(payload.messageId || '');
      const content = String(payload.content || '').trim();
      if (!messageId) throw new Error('messageId required');
      if (!content) throw new Error('Empty');
      if (content.length > 1500) throw new Error('Too long');

      const msg = db.messages.find(m => m.id === messageId);
      if (!msg) throw new Error('Not found');
      if (msg.senderId !== user.id) throw new Error('Forbidden');
      if (msg.deletedAt) throw new Error('Deleted');
      const now = Date.now();
      if (now - msg.createdAt > 60 * 1000) throw new Error('Edit window expired');

      msg.content = content;
      msg.editedAt = now;
      persist();

      io.to('thread:' + msg.threadId).emit('message:edit', { messageId: msg.id, content: msg.content, editedAt: msg.editedAt });
      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ ok: false, error: e.message || 'error' });
    }
  });

  // Delete message (within 60s)
  socket.on('message:delete', (payload, cb) => {
    try {
      const messageId = String(payload.messageId || '');
      if (!messageId) throw new Error('messageId required');

      const msg = db.messages.find(m => m.id === messageId);
      if (!msg) throw new Error('Not found');
      if (msg.senderId !== user.id) throw new Error('Forbidden');
      if (msg.deletedAt) throw new Error('Already deleted');
      const now = Date.now();
      if (now - msg.createdAt > 60 * 1000) throw new Error('Delete window expired');

      msg.deletedAt = now;
      persist();

      io.to('thread:' + msg.threadId).emit('message:delete', { messageId: msg.id, deletedAt: msg.deletedAt });
      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ ok: false, error: e.message || 'error' });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`tonkotsu.online running on :${PORT}`);
});
