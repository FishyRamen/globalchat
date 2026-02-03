'use strict';
/**
 * server.js (Node ONLY) — Express + Socket.IO + API
 * ✅ No window / DOM references.
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

const BETA_USERS = new Set((process.env.BETA_USERS || '').split(',').map(s => s.trim()).filter(Boolean));
const EARLY_ACCESS_USERS = new Set((process.env.EARLY_ACCESS_USERS || '').split(',').map(s => s.trim()).filter(Boolean));
const ANNOUNCEMENT_USERS = new Set((process.env.ANNOUNCEMENT_USERS || '').split(',').map(s => s.trim()).filter(Boolean));

const COOLDOWN_GUEST_GLOBAL = 5000;
const COOLDOWN_USER_GLOBAL = 3000;
const EDIT_WINDOW = 60 * 1000;

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    const p = path.join(DATA_DIR, file);
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return fallback; }
}
function writeJson(file, data) {
  const p = path.join(DATA_DIR, file);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

const db = {
  users: readJson('users.json', []),
  threads: readJson('threads.json', []),
  messages: readJson('messages.json', []),
};

function persist() {
  writeJson('users.json', db.users);
  writeJson('threads.json', db.threads);
  writeJson('messages.json', db.messages);
}

function uid(prefix = '') { return prefix + crypto.randomBytes(12).toString('hex'); }

function sanitizeUsername(name) {
  const s = (name || '').trim();
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(s)) return null;
  return s;
}

function signToken(payload) { return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' }); }
function verifyToken(token) { try { return jwt.verify(token, JWT_SECRET); } catch { return null; } }

function stableColor(username) {
  const h = crypto.createHash('sha1').update(String(username)).digest('hex').slice(0, 8);
  const n = parseInt(h, 16);
  const hue = n % 360;
  return `hsl(${hue} 62% 62%)`;
}

function normalizeUser(user) {
  user.bio = user.bio || '';
  user.statusText = user.statusText || '';
  user.presence = user.presence || 'online';
  user.badges = Array.isArray(user.badges) ? user.badges : [];
  user.friends = Array.isArray(user.friends) ? user.friends : [];
  user.blocked = Array.isArray(user.blocked) ? user.blocked : [];
  user.friendRequestsIn = Array.isArray(user.friendRequestsIn) ? user.friendRequestsIn : [];
  user.friendRequestsOut = Array.isArray(user.friendRequestsOut) ? user.friendRequestsOut : [];
  user.color = user.color || stableColor(user.username);
}

function ensureBadges(user) {
  normalizeUser(user);
  const set = new Set(user.badges || []);
  if (user.isGuest) set.add('GUEST');
  if (BETA_USERS.has(user.username)) set.add('BETA');
  if (EARLY_ACCESS_USERS.has(user.username)) set.add('EARLY ACCESS');
  if (ANNOUNCEMENT_USERS.has(user.username)) set.add('ANNOUNCEMENT');
  user.badges = Array.from(set);
}

function getUserPublic(u) {
  normalizeUser(u);
  ensureBadges(u);
  return {
    id: u.id,
    username: u.username,
    bio: u.bio,
    statusText: u.statusText,
    presence: u.presence,
    badges: u.badges,
    isGuest: !!u.isGuest,
    createdAt: u.createdAt,
    color: u.color,
  };
}

function findUserById(id) { return db.users.find(u => u.id === id); }
function findUserByName(username) {
  return db.users.find(u => u.username.toLowerCase() === String(username || '').toLowerCase());
}

function ensureGlobalThread() {
  let t = db.threads.find(x => x.type === 'global');
  if (!t) {
    t = { id: 'global', type: 'global', name: 'Global', members: [], createdBy: null, createdAt: Date.now() };
    db.threads.unshift(t);
  }
}
ensureGlobalThread();

function threadById(threadId) { return db.threads.find(t => t.id === threadId); }
function threadAllowed(threadId, userId) {
  if (threadId === 'global') return true;
  const t = threadById(threadId);
  if (!t) return false;
  return Array.isArray(t.members) && t.members.includes(userId);
}

function normalizeGroup(thread) {
  if (thread.type !== 'group') return;
  thread.roles = thread.roles && typeof thread.roles === 'object' ? thread.roles : {};
  if (thread.createdBy && !thread.roles[thread.createdBy]) thread.roles[thread.createdBy] = 'owner';
}
function isGroupOwner(thread, userId) { normalizeGroup(thread); return thread.roles && thread.roles[userId] === 'owner'; }

function isBlocked(aUser, bUserId) { normalizeUser(aUser); return aUser.blocked.includes(bUserId); }
function eitherBlocked(aId, bId) {
  const a = findUserById(aId);
  const b = findUserById(bId);
  if (!a || !b) return false;
  return isBlocked(a, bId) || isBlocked(b, aId);
}

// profanity / explicit filter (best-effort, server-side)
const BAD_PATTERNS = [
  /n[\W_]*[i1l!][\W_]*g[\W_]*g[\W_]*[e3][\W_]*r/gi,
  /\b(porn|p0rn|hentai|xxx|xvideos|pornhub|onlyfans)\b/gi,
  /\b(fuck|f\W*u\W*c\W*k|shit|bitch|cunt|dick|pussy|rape)\b/gi,
];
function censorText(s) {
  let out = String(s || '');
  for (const re of BAD_PATTERNS) out = out.replace(re, (m) => '*'.repeat(Math.min(8, Math.max(4, m.length))));
  return out;
}

// links blocked in global
const URL_RE = /(?:https?:\/\/|www\.)[^\s]+/i;
const DOMAIN_RE = /\b[a-z0-9-]+\.(?:com|net|org|gg|io|me|co|ca|uk|ru|xyz|app|dev|site|online|link|tv|cc)\b/i;
function containsLink(s) {
  const t = String(s || '');
  return URL_RE.test(t) || DOMAIN_RE.test(t);
}

// Express
const app = express();
app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.static(PUBLIC_DIR));

// auth middleware
function authMiddleware(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  const decoded = token ? verifyToken(token) : null;
  if (!decoded) return res.status(401).json({ error: 'Unauthorized' });
  const user = findUserById(decoded.id);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });
  normalizeUser(user);
  ensureBadges(user);
  req.user = user;
  next();
}

// register
app.post('/api/register', async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');

  if (!username) return res.status(400).json({ error: 'Username must be 2-20 chars: letters, numbers, underscore.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (password !== password2) return res.status(400).json({ error: 'Passwords do not match.' });
  if (findUserByName(username)) return res.status(409).json({ error: 'Username already taken.' });

  const passHash = await bcrypt.hash(password, 10);
  const user = {
    id: uid('u_'),
    username,
    passHash,
    bio: '',
    statusText: '',
    presence: 'online',
    badges: ['BETA'],
    friends: [],
    blocked: [],
    friendRequestsIn: [],
    friendRequestsOut: [],
    isGuest: false,
    createdAt: Date.now(),
    color: stableColor(username),
  };
  ensureBadges(user);
  db.users.push(user);
  persist();

  const token = signToken({ id: user.id });
  res.json({ token, user: getUserPublic(user), isFirstAccountLogin: true });
});

// login
app.post('/api/login', async (req, res) => {
  const username = sanitizeUsername(req.body.username);
  const password = String(req.body.password || '');
  if (!username || !password) return res.status(400).json({ error: 'Missing credentials.' });

  const user = findUserByName(username);
  if (!user || user.isGuest) {
    return res.status(404).json({ error: 'This account does not exist. Use Register to create one or Guest to try the app.' });
  }

  const ok = await bcrypt.compare(password, user.passHash);
  if (!ok) return res.status(401).json({ error: 'Wrong password.' });

  normalizeUser(user);
  ensureBadges(user);
  persist();

  const token = signToken({ id: user.id });
  res.json({ token, user: getUserPublic(user) });
});

// guest
app.post('/api/guest', (req, res) => {
  const base = 'guest' + Math.floor(Math.random() * 10000);
  let username = base;
  let i = 0;
  while (findUserByName(username)) { i++; username = base + '_' + i; }

  const user = {
    id: uid('g_'),
    username,
    passHash: null,
    bio: '',
    statusText: '',
    presence: 'online',
    badges: ['GUEST'],
    friends: [],
    blocked: [],
    friendRequestsIn: [],
    friendRequestsOut: [],
    isGuest: true,
    createdAt: Date.now(),
    color: stableColor(username),
  };
  ensureBadges(user);
  db.users.push(user);
  persist();

  const token = signToken({ id: user.id });
  res.json({ token, user: getUserPublic(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  res.json({
    user: getUserPublic(req.user),
    friends: req.user.friends,
    blocked: req.user.blocked,
    friendRequestsIn: req.user.friendRequestsIn,
    friendRequestsOut: req.user.friendRequestsOut,
  });
});

app.post('/api/me/profile', authMiddleware, (req, res) => {
  const bio = String(req.body.bio || '').slice(0, 240);
  const statusText = String(req.body.statusText || '').slice(0, 64);
  const presence = String(req.body.presence || '');
  const validPresence = new Set(['online', 'idle', 'dnd', 'invisible']);

  req.user.bio = censorText(bio);
  req.user.statusText = censorText(statusText);
  if (validPresence.has(presence)) req.user.presence = presence;

  ensureBadges(req.user);
  persist();

  io.emit('presence:update', { user: getUserPublic(req.user) });
  io.emit('presence:list', { users: getOnlinePublicList() });

  res.json({ user: getUserPublic(req.user) });
});

// friends
app.post('/api/friends/request', authMiddleware, (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: 'Guests cannot add friends.' });
  const targetName = String(req.body.username || '').trim();
  const target = findUserByName(targetName);
  if (!target || target.isGuest) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot friend yourself.' });

  normalizeUser(target);
  if (eitherBlocked(req.user.id, target.id)) return res.status(403).json({ error: 'Cannot friend (blocked).' });

  if (req.user.friends.includes(target.id)) return res.json({ ok: true, already: true });

  if (!req.user.friendRequestsOut.includes(target.id)) req.user.friendRequestsOut.push(target.id);
  if (!target.friendRequestsIn.includes(req.user.id)) target.friendRequestsIn.push(req.user.id);

  persist();

  const dmId = ensureDMThread(req.user.id, target.id);
  const msg = makeMessage({
    threadId: dmId,
    sender: req.user,
    content: `${req.user.username} sent you a friend request.`,
    type: 'friend_request',
    meta: { fromId: req.user.id }
  });
  db.messages.push(msg);
  persist();
  io.to('thread:' + dmId).emit('message:new', { message: msg });

  res.json({ ok: true });
});

app.post('/api/friends/respond', authMiddleware, (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: 'Guests cannot do this.' });
  const fromId = String(req.body.fromId || '');
  const accept = !!req.body.accept;

  const from = findUserById(fromId);
  if (!from || from.isGuest) return res.status(404).json({ error: 'User not found.' });
  normalizeUser(from);

  if (!req.user.friendRequestsIn.includes(fromId)) return res.status(400).json({ error: 'No such request.' });

  req.user.friendRequestsIn = req.user.friendRequestsIn.filter(x => x !== fromId);
  from.friendRequestsOut = from.friendRequestsOut.filter(x => x !== req.user.id);

  if (accept) {
    if (!req.user.friends.includes(fromId)) req.user.friends.push(fromId);
    if (!from.friends.includes(req.user.id)) from.friends.push(req.user.id);
  }
  persist();

  const dmId = ensureDMThread(req.user.id, fromId);
  const msg = makeMessage({
    threadId: dmId,
    sender: req.user,
    content: accept ? `✅ You are now friends with ${from.username}.` : `❌ Friend request declined.`,
    type: 'system',
    meta: { friendRespond: true, accept }
  });
  db.messages.push(msg);
  persist();
  io.to('thread:' + dmId).emit('message:new', { message: msg });

  res.json({ ok: true });
});

// block
app.post('/api/block', authMiddleware, (req, res) => {
  const targetName = String(req.body.username || '').trim();
  const target = findUserByName(targetName);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot block yourself.' });

  normalizeUser(req.user);
  if (!req.user.blocked.includes(target.id)) req.user.blocked.push(target.id);

  // clean relations
  req.user.friendRequestsIn = req.user.friendRequestsIn.filter(x => x !== target.id);
  req.user.friendRequestsOut = req.user.friendRequestsOut.filter(x => x !== target.id);
  req.user.friends = req.user.friends.filter(x => x !== target.id);

  normalizeUser(target);
  target.friendRequestsIn = target.friendRequestsIn.filter(x => x !== req.user.id);
  target.friendRequestsOut = target.friendRequestsOut.filter(x => x !== req.user.id);
  target.friends = target.friends.filter(x => x !== req.user.id);

  persist();
  res.json({ ok: true });
});

app.post('/api/unblock', authMiddleware, (req, res) => {
  const targetName = String(req.body.username || '').trim();
  const target = findUserByName(targetName);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  normalizeUser(req.user);
  req.user.blocked = req.user.blocked.filter(x => x !== target.id);
  persist();
  res.json({ ok: true });
});

// threads list
app.get('/api/threads', authMiddleware, (req, res) => {
  const myId = req.user.id;
  const threads = db.threads
    .filter(t => t.type === 'global' || (Array.isArray(t.members) && t.members.includes(myId)))
    .map(t => {
      if (t.type === 'dm') {
        const otherId = t.members.find(x => x !== myId);
        const other = otherId ? findUserById(otherId) : null;
        return { id: t.id, type: t.type, name: other ? other.username : 'DM', members: t.members, createdAt: t.createdAt };
      }
      if (t.type === 'group') normalizeGroup(t);
      return { id: t.id, type: t.type, name: t.name, members: t.members || [], createdAt: t.createdAt, roles: t.roles || {} };
    });
  res.json({ threads });
});

function ensureDMThread(aId, bId) {
  let t = db.threads.find(x =>
    x.type === 'dm' &&
    Array.isArray(x.members) &&
    x.members.length === 2 &&
    x.members.includes(aId) &&
    x.members.includes(bId)
  );
  if (!t) {
    t = { id: uid('t_'), type: 'dm', name: '', members: [aId, bId], createdBy: aId, createdAt: Date.now() };
    db.threads.push(t);
    persist();
  }
  return t.id;
}

app.post('/api/threads/dm', authMiddleware, (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: 'Guests cannot DM.' });
  const targetName = String(req.body.username || '').trim();
  const target = findUserByName(targetName);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot DM yourself.' });
  if (eitherBlocked(req.user.id, target.id)) return res.status(403).json({ error: 'DM blocked.' });

  const threadId = ensureDMThread(req.user.id, target.id);
  res.json({ threadId });
});

app.post('/api/threads/group', authMiddleware, (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: 'Guests cannot create groups.' });
  const name = censorText(String(req.body.name || '').trim().slice(0, 40));
  if (!name) return res.status(400).json({ error: 'Group name required.' });

  const t = { id: uid('t_'), type: 'group', name, members: [req.user.id], roles: { [req.user.id]: 'owner' }, createdBy: req.user.id, createdAt: Date.now() };
  db.threads.push(t);
  persist();
  res.json({ threadId: t.id });
});

// group invites
app.post('/api/groups/invite', authMiddleware, (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: 'Guests cannot invite.' });

  const groupId = String(req.body.groupId || '');
  const targetId = String(req.body.userId || '');
  const group = threadById(groupId);
  if (!group || group.type !== 'group') return res.status(404).json({ error: 'Group not found.' });
  normalizeGroup(group);

  if (!threadAllowed(groupId, req.user.id)) return res.status(403).json({ error: 'Forbidden.' });
  if (!isGroupOwner(group, req.user.id)) return res.status(403).json({ error: 'Only owner can invite (for now).' });

  const target = findUserById(targetId);
  if (!target || target.isGuest) return res.status(404).json({ error: 'User not found.' });

  normalizeUser(req.user);
  if (!req.user.friends.includes(targetId)) return res.status(403).json({ error: 'You must be friends to invite.' });
  if (eitherBlocked(req.user.id, targetId)) return res.status(403).json({ error: 'Invite blocked.' });

  if (group.members.includes(targetId)) return res.json({ ok: true, already: true });

  const dmId = ensureDMThread(req.user.id, targetId);
  const msg = makeMessage({
    threadId: dmId,
    sender: req.user,
    content: `Invite to join "${group.name}"`,
    type: 'invite',
    meta: { groupId: group.id, groupName: group.name, invitedId: targetId, inviterId: req.user.id }
  });

  db.messages.push(msg);
  persist();
  io.to('thread:' + dmId).emit('message:new', { message: msg });

  res.json({ ok: true });
});

app.post('/api/groups/invite/respond', authMiddleware, (req, res) => {
  if (req.user.isGuest) return res.status(403).json({ error: 'Guests cannot join groups.' });

  const groupId = String(req.body.groupId || '');
  const inviterId = String(req.body.inviterId || '');
  const accept = !!req.body.accept;

  const group = threadById(groupId);
  if (!group || group.type !== 'group') return res.status(404).json({ error: 'Group not found.' });
  normalizeGroup(group);

  if (accept) {
    if (eitherBlocked(req.user.id, inviterId)) return res.status(403).json({ error: 'Blocked.' });
    if (!group.members.includes(req.user.id)) group.members.push(req.user.id);
    group.roles = group.roles || {};
    if (!group.roles[req.user.id]) group.roles[req.user.id] = 'member';
    persist();
  }

  const dmId = inviterId ? ensureDMThread(req.user.id, inviterId) : null;
  if (dmId) {
    const msg = makeMessage({
      threadId: dmId,
      sender: req.user,
      content: accept ? `✅ Joined "${group.name}".` : `❌ Invite declined.`,
      type: 'system',
      meta: { inviteRespond: true, groupId, accept }
    });
    db.messages.push(msg);
    persist();
    io.to('thread:' + dmId).emit('message:new', { message: msg });
  }

  res.json({ ok: true });
});

// messages list
app.get('/api/messages', authMiddleware, (req, res) => {
  const threadId = String(req.query.threadId || '');
  if (!threadId) return res.status(400).json({ error: 'threadId required.' });

  const thread = threadById(threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found.' });

  const myId = req.user.id;
  const allowed = thread.type === 'global' || (Array.isArray(thread.members) && thread.members.includes(myId));
  if (!allowed) return res.status(403).json({ error: 'Forbidden.' });

  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || '80', 10) || 80));
  let msgs = db.messages.filter(m => m.threadId === threadId);
  msgs.sort((a, b) => a.createdAt - b.createdAt);
  msgs = msgs.slice(-limit);
  res.json({ messages: msgs });
});

// announcements
app.post('/api/announce', authMiddleware, (req, res) => {
  ensureBadges(req.user);
  if (req.user.isGuest) return res.status(403).json({ error: 'Guests cannot announce.' });
  if (!req.user.badges.includes('ANNOUNCEMENT')) return res.status(403).json({ error: 'Missing ANNOUNCEMENT badge.' });

  const content = censorText(String(req.body.content || '').trim().slice(0, 1500));
  if (!content) return res.status(400).json({ error: 'Empty announcement.' });

  const msg = makeMessage({ threadId: 'global', sender: req.user, content, type: 'announcement', clientId: null, meta: null });
  db.messages.push(msg);
  persist();
  io.to('thread:global').emit('message:new', { message: msg });

  res.json({ ok: true });
});

// Socket.IO
const httpServer = require('http').createServer(app);
const io = new Server(httpServer, { cors: { origin: '*', methods: ['GET', 'POST'] } });

const socketsByUser = new Map();
const onlineUsers = new Map();

function effectivePresence(u, info) {
  if (u.presence === 'invisible') return 'invisible';
  if (info && info.idleAt) return 'idle';
  return u.presence || 'online';
}

function getOnlinePublicList() {
  const out = [];
  for (const [userId, info] of onlineUsers.entries()) {
    const u = findUserById(userId);
    if (!u) continue;
    normalizeUser(u);
    ensureBadges(u);
    const pres = effectivePresence(u, info);
    if (pres === 'invisible') continue;
    out.push({ user: { ...getUserPublic(u), presence: pres }, lastSeen: info.lastSeen });
  }
  const rank = { online: 0, idle: 1, dnd: 2 };
  out.sort((a, b) => {
    const ra = rank[a.user.presence] ?? 9;
    const rb = rank[b.user.presence] ?? 9;
    if (ra !== rb) return ra - rb;
    return a.user.username.localeCompare(b.user.username);
  });
  return out;
}

function makeMessage({ threadId, sender, content, type, clientId, meta }) {
  const now = Date.now();
  return {
    id: uid('m_'),
    threadId,
    senderId: sender.id,
    senderName: sender.username,
    senderColor: sender.color || stableColor(sender.username),
    content,
    type: type || 'message',
    meta: meta || null,
    clientId: clientId || null,
    createdAt: now,
    editedAt: null,
    deletedAt: null
  };
}

const recentClientIds = new Map();
function isDuplicate(senderId, clientId) {
  if (!clientId) return false;
  const key = senderId + '|' + clientId;
  const now = Date.now();
  for (const [k, ts] of recentClientIds.entries()) {
    if (now - ts > 5 * 60 * 1000) recentClientIds.delete(k);
  }
  if (recentClientIds.has(key)) return true;
  recentClientIds.set(key, now);
  return false;
}

const lastGlobalSend = new Map();

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const decoded = token ? verifyToken(token) : null;
  if (!decoded) return next(new Error('unauthorized'));
  const user = findUserById(decoded.id);
  if (!user) return next(new Error('unauthorized'));
  normalizeUser(user);
  ensureBadges(user);
  socket.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.user;

  if (!socketsByUser.has(user.id)) socketsByUser.set(user.id, new Set());
  socketsByUser.get(user.id).add(socket.id);

  onlineUsers.set(user.id, { lastSeen: Date.now(), presence: user.presence, idleAt: null });
  io.emit('presence:list', { users: getOnlinePublicList() });

  socket.on('disconnect', () => {
    const set = socketsByUser.get(user.id);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) socketsByUser.delete(user.id);
    }
    if (!socketsByUser.has(user.id)) {
      onlineUsers.delete(user.id);
      io.emit('presence:list', { users: getOnlinePublicList() });
    }
  });

  socket.on('thread:join', (payload, cb) => {
    try {
      const threadId = String(payload?.threadId || '');
      if (!threadId) throw new Error('threadId required');
      if (!threadAllowed(threadId, user.id)) throw new Error('forbidden');
      socket.join('thread:' + threadId);
      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ ok: false, error: e.message || 'error' });
    }
  });

  socket.on('presence:set', (payload, cb) => {
    const presence = String(payload?.presence || '');
    const valid = new Set(['online', 'idle', 'dnd', 'invisible']);
    if (valid.has(presence)) {
      user.presence = presence;
      persist();
      const info = onlineUsers.get(user.id) || { lastSeen: Date.now(), idleAt: null };
      info.lastSeen = Date.now();
      info.presence = presence;
      info.idleAt = (presence === 'idle') ? Date.now() : null;
      onlineUsers.set(user.id, info);
      io.emit('presence:update', { user: getUserPublic(user) });
      io.emit('presence:list', { users: getOnlinePublicList() });
    }
    cb && cb({ ok: true });
  });

  socket.on('activity:ping', (_payload, cb) => {
    const info = onlineUsers.get(user.id);
    if (info) {
      info.lastSeen = Date.now();
      info.idleAt = null;
      onlineUsers.set(user.id, info);
      io.emit('presence:list', { users: getOnlinePublicList() });
    }
    cb && cb({ ok: true });
  });

  socket.on('activity:idle', (_payload, cb) => {
    const info = onlineUsers.get(user.id);
    if (info) {
      info.lastSeen = Date.now();
      info.idleAt = Date.now();
      onlineUsers.set(user.id, info);
      io.emit('presence:list', { users: getOnlinePublicList() });
    }
    cb && cb({ ok: true });
  });

  socket.on('message:send', (payload, cb) => {
    try {
      const threadId = String(payload?.threadId || '');
      let content = String(payload?.content || '').trim();
      const clientId = payload?.clientId ? String(payload.clientId) : null;

      if (!threadId) throw new Error('threadId required');
      if (!content) throw new Error('Empty message');
      if (content.length > 1500) throw new Error('Message too long');

      if (!threadAllowed(threadId, user.id)) throw new Error('Forbidden');

      if (user.isGuest && threadId !== 'global') throw new Error('Guests cannot DM or join groups.');

      const thr = threadById(threadId);
      if (thr && thr.type === 'dm') {
        const otherId = thr.members.find(x => x !== user.id);
        if (otherId && eitherBlocked(user.id, otherId)) throw new Error('DM blocked.');
      }

      if (threadId === 'global' && containsLink(content)) throw new Error('Links are not allowed in global chat.');

      if (threadId === 'global') {
        const now = Date.now();
        const last = lastGlobalSend.get(user.id) || 0;
        const cd = user.isGuest ? COOLDOWN_GUEST_GLOBAL : COOLDOWN_USER_GLOBAL;
        const remaining = cd - (now - last);
        if (remaining > 0) throw new Error('Cooldown:' + remaining);
        lastGlobalSend.set(user.id, now);
      }

      content = censorText(content);

      if (isDuplicate(user.id, clientId)) {
        cb && cb({ ok: true, duplicate: true });
        return;
      }

      const msg = makeMessage({ threadId, sender: user, content, type: 'message', clientId, meta: null });
      db.messages.push(msg);
      persist();
      io.to('thread:' + threadId).emit('message:new', { message: msg });
      cb && cb({ ok: true, message: msg });
    } catch (e) {
      cb && cb({ ok: false, error: e.message || 'error' });
    }
  });

  socket.on('message:edit', (payload, cb) => {
    try {
      const messageId = String(payload?.messageId || '');
      let content = String(payload?.content || '').trim();
      if (!messageId) throw new Error('messageId required');
      if (!content) throw new Error('Empty');
      if (content.length > 1500) throw new Error('Too long');

      const msg = db.messages.find(m => m.id === messageId);
      if (!msg) throw new Error('Not found');
      if (msg.senderId !== user.id) throw new Error('Forbidden');
      if (msg.deletedAt) throw new Error('Deleted');
      const now = Date.now();
      if (now - msg.createdAt > EDIT_WINDOW) throw new Error('Edit window expired');

      if (msg.threadId === 'global' && containsLink(content)) throw new Error('Links are not allowed in global chat.');

      content = censorText(content);
      msg.content = content;
      msg.editedAt = now;
      persist();
      io.to('thread:' + msg.threadId).emit('message:edit', { messageId: msg.id, content: msg.content, editedAt: msg.editedAt });
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message || 'error' }); }
  });

  socket.on('message:delete', (payload, cb) => {
    try {
      const messageId = String(payload?.messageId || '');
      if (!messageId) throw new Error('messageId required');

      const msg = db.messages.find(m => m.id === messageId);
      if (!msg) throw new Error('Not found');
      if (msg.senderId !== user.id) throw new Error('Forbidden');
      if (msg.deletedAt) throw new Error('Already deleted');
      const now = Date.now();
      if (now - msg.createdAt > EDIT_WINDOW) throw new Error('Delete window expired');

      msg.deletedAt = now;
      persist();
      io.to('thread:' + msg.threadId).emit('message:delete', { messageId: msg.id, deletedAt: msg.deletedAt });
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message || 'error' }); }
  });
});

httpServer.listen(PORT, () => console.log(`tonkotsu.online running on :${PORT}`));
