// server.js (ESM) — Render-ready, disk-ready persistence, compact chat app
import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";
import fs from "fs";
import path from "path";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

/**
 * Persistence (Render disk-ready)
 * If you add a Render Persistent Disk mounted at /data,
 * this will store to: /data/tonkotsu.json
 */
const DISK_FILE = process.env.TONKOTSU_DB_FILE || "/data/tonkotsu.json";

function now() { return Date.now(); }
function safeJson(obj) { return JSON.stringify(obj, null, 2); }

const db = {
  users: {},        // username -> user record
  tokens: {},       // token -> username
  global: [],       // [{user,text,ts}]
  dms: {},          // "a|b" -> [{user,text,ts}]
  groups: {},       // gid -> {id,name,owner,members,msgs,active,pendingInvites,visibility,maxMembers}
  groupInvites: {}, // username -> [{id, from, name, ts}]
  inboxMentions: {} // username -> [{id, from, where, text, ts}]
};

function normalizeUser(u) { return String(u || "").trim(); }
function dmKey(a, b) {
  const x = String(a), y = String(b);
  return (x.localeCompare(y) <= 0) ? `${x}|${y}` : `${y}|${x}`;
}

function usernameValid(u) {
  return /^[A-Za-z0-9_.]{3,20}$/.test(u);
}

// keep basic blocks; no explicit slur lists
const USERNAME_BLOCK_PATTERNS = [
  /porn|onlyfans|nude|nsfw|sex|xxx/i,
  /child|minor|underage/i,
  /rape|rapist/i,
  /hitler|nazi/i
];
function badUsername(u) {
  const s = String(u || "");
  return USERNAME_BLOCK_PATTERNS.some(rx => rx.test(s));
}

// hide (not delete) extremely harmful patterns
const HARD_BLOCK_PATTERNS = [
  /\b(kys|kill\s+yourself)\b/i,
  /\b(i('?m| am)?\s+going\s+to\s+kill|i('?m| am)?\s+gonna\s+kill)\b/i,
  /\b(send\s+nudes|nude\s+pics)\b/i,
  /\b(dox|doxx|address|phone\s*number)\b/i
];
function shouldHardHide(text) {
  const t = String(text || "");
  return HARD_BLOCK_PATTERNS.some(rx => rx.test(t));
}

// Password hashing
function hashPass(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.pbkdf2Sync(String(pw), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${derived}`;
}
function checkPass(pw, stored) {
  const [salt, derived] = String(stored || "").split(":");
  if (!salt || !derived) return false;
  const test = crypto.pbkdf2Sync(String(pw), salt, 120000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(test), Buffer.from(derived));
}
function newToken() { return crypto.randomBytes(24).toString("hex"); }

// XP model
function xpNext(level) {
  const base = 120;
  const growth = Math.floor(base * Math.pow(Math.max(1, level), 1.5));
  return Math.max(base, growth);
}
function addXP(userRec, amount) {
  if (!userRec || userRec.guest) return { leveledUp: false };
  if (!userRec.xp) userRec.xp = { level: 1, xp: 0, next: xpNext(1) };

  const before = userRec.xp.level;
  userRec.xp.xp += amount;

  while (userRec.xp.xp >= userRec.xp.next) {
    userRec.xp.xp -= userRec.xp.next;
    userRec.xp.level += 1;
    userRec.xp.next = xpNext(userRec.xp.level);
  }
  return { leveledUp: userRec.xp.level > before };
}

function defaultSettings() {
  return {
    density: 0.12,
    cursorMode: "trail",   // off | dot | trail
    reduceAnimations: false,
    sounds: true
  };
}

function defaultPrefs() {
  return {
    allowFriendRequests: true,
    allowGroupInvites: true,
    showCountry: true
  };
}

function ensureUser(username, password) {
  if (!db.users[username]) {
    db.users[username] = {
      username,
      pass: hashPass(password),
      createdAt: now(),
      guest: false,
      settings: defaultSettings(),
      prefs: defaultPrefs(),
      profile: { country: "" },
      bio: "",
      status: "online", // online | idle | dnd | invisible
      social: {
        friends: [],
        incoming: [],
        outgoing: [],
        blocked: []
      },
      stats: { messages: 0 },
      xp: { level: 1, xp: 0, next: xpNext(1) }
    };
  } else {
    const u = db.users[username];
    u.settings = u.settings || defaultSettings();
    u.prefs = u.prefs || defaultPrefs();
    u.profile = u.profile || { country: "" };
    u.bio = u.bio ?? "";
    u.status = u.status || "online";
    u.social = u.social || { friends: [], incoming: [], outgoing: [], blocked: [] };
    u.stats = u.stats || { messages: 0 };
    u.xp = u.xp || { level: 1, xp: 0, next: xpNext(1) };
  }
  return db.users[username];
}

// Disk load/save
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveToDisk().catch(() => {});
  }, 700);
}

async function loadFromDisk() {
  try {
    if (!fs.existsSync(DISK_FILE)) return;
    const raw = await fs.promises.readFile(DISK_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      db.users = parsed.users || db.users;
      db.tokens = parsed.tokens || {};
      db.global = parsed.global || [];
      db.dms = parsed.dms || {};
      db.groups = parsed.groups || {};
      db.groupInvites = parsed.groupInvites || {};
      db.inboxMentions = parsed.inboxMentions || {};
    }

    // upgrade missing fields
    for (const [name, u] of Object.entries(db.users)) {
      if (!u.guest && u.pass) ensureUser(name, "temp");
      // if u.pass is null => reserved bot / simulated
      if (u && !u.prefs) u.prefs = defaultPrefs();
      if (u && !u.profile) u.profile = { country: "" };
    }

    console.log("[db] loaded", DISK_FILE);
  } catch (e) {
    console.log("[db] load failed", e?.message || e);
  }
}

async function saveToDisk() {
  try {
    const dir = path.dirname(DISK_FILE);
    if (!fs.existsSync(dir)) return;
    const payload = {
      users: db.users,
      tokens: db.tokens,
      global: db.global,
      dms: db.dms,
      groups: db.groups,
      groupInvites: db.groupInvites,
      inboxMentions: db.inboxMentions
    };
    await fs.promises.writeFile(DISK_FILE, safeJson(payload), "utf8");
  } catch {
    // ignore
  }
}

await loadFromDisk();

// Online tracking
const socketToUser = new Map(); // socket.id -> username
const userToSockets = new Map(); // username -> Set(socket.id)
const online = new Set();

function isGuestName(name) {
  return /^Guest\d{4,5}$/.test(String(name || ""));
}

function userVisibleOnlineList() {
  const list = [];
  for (const u of Array.from(online)) {
    const rec = db.users[u];
    if (rec && rec.status === "invisible") continue;
    list.push({
      user: u,
      status: rec?.status || "online",
      guest: !!rec?.guest || isGuestName(u)
    });
  }
  return list.sort((a, b) => a.user.localeCompare(b.user));
}

function emitOnline() {
  io.emit("onlineUsers", userVisibleOnlineList());
}

function ensureInboxMentionBucket(username) {
  if (!db.inboxMentions[username]) db.inboxMentions[username] = [];
  return db.inboxMentions[username];
}

function addMentionToInbox(targetUser, fromUser, where, text) {
  if (!db.users[targetUser] || db.users[targetUser].guest) return;
  const bucket = ensureInboxMentionBucket(targetUser);
  bucket.unshift({
    id: crypto.randomBytes(8).toString("hex"),
    from: fromUser,
    where, // "Global" | "DM" | "Group:<name>"
    text: String(text || "").slice(0, 140),
    ts: now()
  });
  db.inboxMentions[targetUser] = bucket.slice(0, 60);
}

function extractMentions(text) {
  const t = String(text || "");
  const matches = t.match(/@([A-Za-z0-9_.]{3,20})/g) || [];
  const users = new Set();
  for (const m of matches) users.add(m.slice(1));
  return Array.from(users);
}

function computeInboxCounts(username) {
  const u = db.users[username];
  if (!u || u.guest) return { total: 0, friend: 0, groupInv: 0, ment: 0 };
  const friend = (u.social?.incoming || []).length;
  const groupInv = (db.groupInvites[username] || []).length;
  const ment = (db.inboxMentions[username] || []).length;
  return { total: friend + groupInv + ment, friend, groupInv, ment };
}

function emitInbox(username) {
  const u = db.users[username];
  if (!u || u.guest) return;
  io.to(username).emit("inbox:badge", computeInboxCounts(username));
}

function emitSocial(username) {
  const u = db.users[username];
  if (!u || u.guest) return;
  io.to(username).emit("social:update", u.social);
  emitInbox(username);
}

function emitGroupsList(username) {
  const u = db.users[username];
  if (!u || u.guest) return;

  const groups = Object.values(db.groups)
    .filter(g => g.active && g.members.includes(username))
    .map(g => ({
      id: g.id,
      name: g.name,
      owner: g.owner,
      members: g.members,
      maxMembers: g.maxMembers || 50,
      visibility: g.visibility || "private"
    }));

  io.to(username).emit("groups:list", groups);
}

function getOrCreateDM(key) {
  if (!db.dms[key]) db.dms[key] = [];
  return db.dms[key];
}

function publicProfile(username) {
  const u = db.users[username];
  if (!u) return null;

  if (isGuestName(username) || u.guest) {
    return { user: username, guest: true, status: "online" };
  }

  const showCountry = u.prefs?.showCountry !== false;
  return {
    user: username,
    guest: false,
    createdAt: u.createdAt,
    status: u.status || "online",
    level: u.xp?.level ?? 1,
    xp: u.xp?.xp ?? 0,
    next: u.xp?.next ?? xpNext(1),
    messages: u.stats?.messages ?? 0,
    bio: u.bio ?? "",
    country: showCountry ? (u.profile?.country || "") : ""
  };
}

function trackSocketUser(username, socketId){
  if (!userToSockets.has(username)) userToSockets.set(username, new Set());
  userToSockets.get(username).add(socketId);
}
function untrackSocketUser(username, socketId){
  const s = userToSockets.get(username);
  if (!s) return;
  s.delete(socketId);
  if (s.size === 0) userToSockets.delete(username);
}
function disconnectAllUserSockets(username){
  const s = userToSockets.get(username);
  if (!s) return;
  for (const sid of Array.from(s)){
    const sock = io.sockets.sockets.get(sid);
    try { sock?.disconnect(true); } catch {}
  }
  userToSockets.delete(username);
}

// ------------------ Simulated load users (clearly labeled) ------------------
// Enable with: SIM_LOAD=true
const SIM_LOAD = String(process.env.SIM_LOAD || "").toLowerCase() === "true";
const simUsers = [
  "Sim_oregon6767","Sim_theowner","Sim_zippyfn","Sim_mikachu","Sim_voidd","Sim_lilsam",
  "Sim_xavier09","Sim_idkbro","Sim_noxity","Sim_bruhmoment","Sim_sarahxoxo","Sim_jaylen"
];

const simLines = [
  "wsg chat",
  "ngl this layout clean",
  "bro my wifi tweaking",
  "lowkey smooth",
  "anyone got tips for groups",
  "bruh",
  "this cursor kinda cool",
  "gtg brb",
  "gotta go wash dishes rq",
  "ima be back",
  "who made this",
  "this better not lag later",
  "wsg chatt",
  "yooo",
  "wsg"
];

const simLeaveLines = ["gtg", "brb", "afk", "gtg brb"];
const simJoinLines = ["yooo", "wsg", "im back", "yo"];

const simCooldown = new Map(); // user -> ts ms

function isReservedBotName(u){
  return /^Sim_/.test(String(u||""));
}

function spawnSimUsers() {
  for (const name of simUsers) {
    if (!db.users[name]) {
      db.users[name] = {
        username: name,
        pass: null, // reserved: cannot log in
        createdAt: now() - Math.floor(Math.random() * 1000 * 60 * 60 * 24 * 200),
        guest: false,
        settings: defaultSettings(),
        prefs: defaultPrefs(),
        profile: { country: "" },
        bio: "bot (sim load)",
        status: "online",
        social: { friends: [], incoming: [], outgoing: [], blocked: [] },
        stats: { messages: Math.floor(Math.random() * 1400) },
        xp: { level: Math.floor(Math.random() * 12) + 1, xp: 0, next: 120 }
      };
    }
    online.add(name);
  }
  emitOnline();
}

function pushGlobal(user, text){
  const msg = { user, text, ts: now() };
  db.global.push(msg);
  if (db.global.length > 350) db.global.shift();
  io.emit("globalMessage", msg);
  scheduleSave();
}

function simMaybeLeaveOrJoin() {
  if (!SIM_LOAD) return;

  if (Math.random() < 0.14) {
    const u = simUsers[Math.floor(Math.random() * simUsers.length)];
    if (online.has(u)) {
      pushGlobal(u, simLeaveLines[Math.floor(Math.random() * simLeaveLines.length)]);
      online.delete(u);
      emitOnline();

      setTimeout(() => {
        online.add(u);
        emitOnline();
        pushGlobal(u, simJoinLines[Math.floor(Math.random() * simJoinLines.length)]);
      }, 22000 + Math.random() * 38000);
    }
  }
}

function simTalk() {
  if (!SIM_LOAD) return;

  const name = simUsers[Math.floor(Math.random() * simUsers.length)];
  if (!online.has(name)) return;

  // cooldown per sim
  const last = simCooldown.get(name) || 0;
  if (now() - last < 7000) return; // roughly similar to real cooldown timing
  simCooldown.set(name, now());

  let text = simLines[Math.floor(Math.random() * simLines.length)];
  if (Math.random() < 0.08) text = text + " lol";
  if (Math.random() < 0.06) text = text + " ngl";

  let safeText = String(text || "").slice(0, 2000);
  if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

  const msg = { user: name, text: safeText, ts: now() };
  db.global.push(msg);
  if (db.global.length > 350) db.global.shift();

  // mention handling
  for (const mention of extractMentions(safeText)) {
    if (db.users[mention] && !db.users[mention].guest) {
      addMentionToInbox(mention, name, "Global", safeText);
      emitInbox(mention);
    }
  }

  io.emit("globalMessage", msg);
  scheduleSave();

  simMaybeLeaveOrJoin();
}

if (SIM_LOAD) {
  setTimeout(() => {
    spawnSimUsers();
    setInterval(simTalk, 4500 + Math.floor(Math.random() * 6500));
  }, 2500);
}

// ---------------- Socket events ----------------
io.on("connection", (socket) => {
  function currentUser() {
    return socketToUser.get(socket.id) || null;
  }

  function requireAuth() {
    const u = currentUser();
    if (!u) return null;
    if (isGuestName(u)) return null;
    return u;
  }

  socket.on("resume", ({ token } = {}) => {
    const t = String(token || "");
    const username = db.tokens[t];
    if (!username || !db.users[username] || db.users[username].guest || !db.users[username].pass) {
      socket.emit("resumeFail");
      return;
    }

    socketToUser.set(socket.id, username);
    trackSocketUser(username, socket.id);
    socket.join(username);

    online.add(username);
    emitOnline();

    const userRec = db.users[username];
    socket.emit("loginSuccess", {
      username,
      guest: false,
      token: t,
      settings: userRec.settings,
      prefs: userRec.prefs,
      profile: userRec.profile,
      social: userRec.social,
      status: userRec.status || "online"
    });

    emitSocial(username);
    emitGroupsList(username);
    emitInbox(username);
  });

  socket.on("login", ({ username, password, guest } = {}) => {
    if (guest) {
      const digits = (Math.random() < 0.5)
        ? String(Math.floor(1000 + Math.random() * 9000))
        : String(Math.floor(10000 + Math.random() * 90000));
      const g = `Guest${digits}`;

      socketToUser.set(socket.id, g);
      socket.join(g);

      online.add(g);
      emitOnline();

      socket.emit("loginSuccess", {
        username: g,
        guest: true,
        token: null,
        settings: defaultSettings(),
        prefs: defaultPrefs(),
        profile: { country:"" },
        social: { friends:[], incoming:[], outgoing:[], blocked:[] },
        status: "online"
      });

      return;
    }

    const u = normalizeUser(username);
    const p = String(password || "");

    if (!usernameValid(u) || badUsername(u)) {
      socket.emit("loginError", "Username not allowed. Use letters/numbers/_/. only (3-20).");
      return;
    }
    if (!p || p.length < 4) {
      socket.emit("loginError", "Password too short.");
      return;
    }

    const existing = db.users[u];

    // Block reserved bot names / sim users from being claimed
    if (existing && !existing.pass) {
      socket.emit("loginError", "That username is reserved.");
      return;
    }
    if (isReservedBotName(u)) {
      socket.emit("loginError", "That username is reserved.");
      return;
    }

    if (!existing) {
      ensureUser(u, p);
      scheduleSave();
    } else {
      ensureUser(u, "temp");
      if (!checkPass(p, existing.pass)) {
        socket.emit("loginError", "Wrong password.");
        return;
      }
    }

    const token = newToken();
    db.tokens[token] = u;

    socketToUser.set(socket.id, u);
    trackSocketUser(u, socket.id);
    socket.join(u);

    online.add(u);
    emitOnline();

    const userRec = db.users[u];
    socket.emit("loginSuccess", {
      username: u,
      guest: false,
      token,
      settings: userRec.settings,
      prefs: userRec.prefs,
      profile: userRec.profile,
      social: userRec.social,
      status: userRec.status || "online"
    });

    emitSocial(u);
    emitGroupsList(u);
    emitInbox(u);
    scheduleSave();
  });

  socket.on("disconnect", () => {
    const u = currentUser();
    socketToUser.delete(socket.id);
    if (u && !isGuestName(u)) untrackSocketUser(u, socket.id);

    if (u) {
      online.delete(u);
      emitOnline();
    }
  });

  // ---------- Settings ----------
  socket.on("settings:update", (settings) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;

    const s = settings || {};
    const cursorMode = ["off", "dot", "trail"].includes(s.cursorMode) ? s.cursorMode : u.settings.cursorMode;

    u.settings = {
      density: Number.isFinite(s.density) ? Math.max(0.08, Math.min(0.22, s.density)) : u.settings.density,
      cursorMode,
      reduceAnimations: !!s.reduceAnimations,
      sounds: s.sounds !== false
    };

    io.to(username).emit("settings", u.settings);
    scheduleSave();
  });

  // ---------- Prefs (privacy) ----------
  socket.on("prefs:get", () => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;
    io.to(username).emit("prefs:data", u.prefs || defaultPrefs());
  });

  socket.on("prefs:update", (p) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;

    const inP = p || {};
    u.prefs = {
      allowFriendRequests: inP.allowFriendRequests !== false,
      allowGroupInvites: inP.allowGroupInvites !== false,
      showCountry: inP.showCountry !== false
    };

    io.to(username).emit("prefs:data", u.prefs);
    scheduleSave();
  });

  // ---------- Profile updates ----------
  socket.on("profile:update", ({ country } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];
    if (!u) return;

    u.profile = u.profile || { country: "" };
    u.profile.country = String(country || "").trim().slice(0, 40);
    scheduleSave();
  });

  // ---------- Status ----------
  socket.on("status:set", ({ status } = {}) => {
    const uName = currentUser();
    if (!uName) return;

    if (isGuestName(uName)) {
      emitOnline();
      return;
    }

    const u = db.users[uName];
    if (!u) return;

    const st = String(status || "");
    if (!["online", "idle", "dnd", "invisible"].includes(st)) return;

    u.status = st;
    emitOnline();
    io.to(uName).emit("status:update", { status: st });
    scheduleSave();
  });

  // ---------- Profile ----------
  socket.on("profile:get", ({ user } = {}) => {
    const target = normalizeUser(user);
    if (!target) return;

    if (isGuestName(target)) {
      socket.emit("profile:data", { user: target, guest: true, status: "online" });
      return;
    }

    const p = publicProfile(target);
    if (!p) {
      socket.emit("profile:data", { user: target, missing: true });
      return;
    }
    socket.emit("profile:data", p);
  });

  // ---------- Account delete ----------
  socket.on("account:delete", ({ password } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const u = db.users[username];
    if (!u || !u.pass) return;

    const pw = String(password || "");
    if (!checkPass(pw, u.pass)) {
      socket.emit("sendError", { reason: "Wrong password." });
      return;
    }

    // Remove tokens for this user
    for (const [t, user] of Object.entries(db.tokens)) {
      if (user === username) delete db.tokens[t];
    }

    // Remove from other users social lists
    for (const other of Object.values(db.users)) {
      if (!other || other.guest || !other.pass) continue;
      other.social.friends = (other.social.friends || []).filter(x => x !== username);
      other.social.incoming = (other.social.incoming || []).filter(x => x !== username);
      other.social.outgoing = (other.social.outgoing || []).filter(x => x !== username);
      other.social.blocked = (other.social.blocked || []).filter(x => x !== username);
    }

    // Remove inbox buckets
    delete db.inboxMentions[username];
    delete db.groupInvites[username];

    // Remove from groups; delete owned groups; clean membership
    for (const [gid, g] of Object.entries(db.groups)) {
      if (!g) continue;

      if (g.owner === username) {
        const members = [...(g.members || [])];
        delete db.groups[gid];
        for (const m of members) {
          io.to(m).emit("group:deleted", { groupId: gid });
          emitGroupsList(m);
        }
        continue;
      }

      if (Array.isArray(g.members) && g.members.includes(username)) {
        g.members = g.members.filter(x => x !== username);
        for (const m of g.members) {
          io.to(m).emit("group:meta", { groupId: gid, meta: { id: gid, name: g.name, owner: g.owner, members: g.members, maxMembers: g.maxMembers, visibility: g.visibility } });
          emitGroupsList(m);
        }
      }

      if (Array.isArray(g.pendingInvites)) {
        g.pendingInvites = g.pendingInvites.filter(x => x !== username);
      }
    }

    // DMs can remain, but the account record is removed.
    delete db.users[username];

    // kick sockets
    io.to(username).emit("account:deleted");
    disconnectAllUserSockets(username);

    scheduleSave();
    emitOnline();
  });

  // ---------- Inbox ----------
  socket.on("inbox:get", () => {
    const username = requireAuth();
    if (!username) return;
    const u = db.users[username];

    const friendReq = (u.social.incoming || []).map(from => ({
      type: "friend",
      id: crypto.randomBytes(8).toString("hex"),
      from,
      text: `${from} sent you a friend request`,
      ts: now()
    }));

    const groupInv = (db.groupInvites[username] || []).map(inv => ({
      type: "group",
      id: inv.id,
      groupId: inv.id,
      from: inv.from,
      name: inv.name,
      text: `${inv.from} invited you to “${inv.name}”`,
      ts: inv.ts
    }));

    const mentions = (db.inboxMentions[username] || []).map(m => ({
      type: "mention",
      id: m.id,
      from: m.from,
      text: `${m.from} mentioned you in ${m.where}: “${m.text}”`,
      ts: m.ts
    }));

    const items = [...mentions, ...groupInv, ...friendReq]
      .sort((a, b) => (b.ts || 0) - (a.ts || 0))
      .slice(0, 80);

    socket.emit("inbox:data", { items });
    emitInbox(username);
  });

  socket.on("inbox:clearMentions", () => {
    const username = requireAuth();
    if (!username) return;
    db.inboxMentions[username] = [];
    emitInbox(username);
    scheduleSave();
  });

  // ---------- Social ----------
  socket.on("social:sync", () => {
    const username = requireAuth();
    if (!username) return;
    emitSocial(username);
  });

  socket.on("friend:request", ({ to } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target] || !db.users[target].pass) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }
    if (target === username) {
      socket.emit("sendError", { reason: "You can’t friend yourself." });
      return;
    }

    const me = db.users[username];
    const them = db.users[target];

    if (them.prefs?.allowFriendRequests === false) {
      socket.emit("sendError", { reason: "That user is not accepting friend requests." });
      return;
    }

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      socket.emit("sendError", { reason: "Blocked." });
      return;
    }
    if (me.social.friends.includes(target)) {
      socket.emit("sendError", { reason: "Already friends." });
      return;
    }
    if (me.social.outgoing.includes(target)) {
      socket.emit("sendError", { reason: "Request already sent." });
      return;
    }

    me.social.outgoing.push(target);
    them.social.incoming.push(username);

    emitSocial(username);
    emitSocial(target);
    scheduleSave();
  });

  socket.on("friend:accept", ({ from } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const src = normalizeUser(from);
    const me = db.users[username];
    const them = db.users[src];
    if (!them || !them.pass) return;

    me.social.incoming = me.social.incoming.filter(x => x !== src);
    them.social.outgoing = them.social.outgoing.filter(x => x !== username);

    if (!me.social.friends.includes(src)) me.social.friends.push(src);
    if (!them.social.friends.includes(username)) them.social.friends.push(username);

    emitSocial(username);
    emitSocial(src);
    scheduleSave();
  });

  socket.on("friend:decline", ({ from } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const src = normalizeUser(from);
    const me = db.users[username];
    const them = db.users[src];
    if (!them || !them.pass) return;

    me.social.incoming = me.social.incoming.filter(x => x !== src);
    them.social.outgoing = them.social.outgoing.filter(x => x !== username);

    emitSocial(username);
    emitSocial(src);
    scheduleSave();
  });

  socket.on("user:block", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(user);
    if (!db.users[target]) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }

    const me = db.users[username];
    if (!me.social.blocked.includes(target)) me.social.blocked.push(target);

    me.social.friends = me.social.friends.filter(x => x !== target);
    me.social.incoming = me.social.incoming.filter(x => x !== target);
    me.social.outgoing = me.social.outgoing.filter(x => x !== target);

    const them = db.users[target];
    if (them && them.pass) {
      them.social.friends = them.social.friends.filter(x => x !== username);
      them.social.incoming = them.social.incoming.filter(x => x !== username);
      them.social.outgoing = them.social.outgoing.filter(x => x !== username);
    }

    emitSocial(username);
    emitSocial(target);
    scheduleSave();
  });

  socket.on("user:unblock", ({ user } = {}) => {
    const username = requireAuth();
    if (!username) return;
    const target = normalizeUser(user);
    const me = db.users[username];
    me.social.blocked = me.social.blocked.filter(x => x !== target);
    emitSocial(username);
    scheduleSave();
  });

  // ---------- Global chat ----------
  socket.on("requestGlobalHistory", () => {
    socket.emit("history", db.global.slice(-220));
  });

  socket.on("sendGlobal", ({ text, ts } = {}) => {
    const sender = currentUser();
    if (!sender) return;

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: sender, text: safeText, ts: Number(ts) || now() };
    db.global.push(msg);
    if (db.global.length > 350) db.global.shift();

    // mentions -> inbox
    for (const mention of extractMentions(safeText)) {
      if (db.users[mention] && !db.users[mention].guest && db.users[mention].pass) {
        addMentionToInbox(mention, sender, "Global", safeText);
        emitInbox(mention);
      }
    }

    io.emit("globalMessage", msg);

    // XP + stats for accounts only
    if (!isGuestName(sender) && db.users[sender] && db.users[sender].pass) {
      const u = db.users[sender];
      u.stats.messages += 1;
      addXP(u, 8);
      scheduleSave();
    }
  });

  // ---------- DMs (friends only) ----------
  socket.on("dm:history", ({ withUser } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const other = normalizeUser(withUser);
    if (!db.users[other] || !db.users[other].pass) {
      socket.emit("dm:history", { withUser: other, msgs: [] });
      return;
    }

    const me = db.users[username];
    if (!(me.social?.friends || []).includes(other)) {
      socket.emit("sendError", { reason: "You can only DM friends." });
      socket.emit("dm:history", { withUser: other, msgs: [] });
      return;
    }

    const key = dmKey(username, other);
    const msgs = (db.dms[key] || []).slice(-220);
    socket.emit("dm:history", { withUser: other, msgs });
  });

  socket.on("dm:send", ({ to, text } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const target = normalizeUser(to);
    if (!db.users[target] || !db.users[target].pass) {
      socket.emit("sendError", { reason: "User not found." });
      return;
    }

    const me = db.users[username];
    const them = db.users[target];

    // friends only
    if (!(me.social?.friends || []).includes(target) || !(them.social?.friends || []).includes(username)) {
      socket.emit("sendError", { reason: "You can only DM friends." });
      return;
    }

    if (me.social.blocked.includes(target) || them.social.blocked.includes(username)) {
      socket.emit("sendError", { reason: "You can’t message this user." });
      return;
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: username, text: safeText, ts: now() };

    const key = dmKey(username, target);
    const list = getOrCreateDM(key);
    list.push(msg);
    if (list.length > 300) list.shift();

    // mentions in DM -> inbox
    for (const mention of extractMentions(safeText)) {
      if (db.users[mention] && !db.users[mention].guest && db.users[mention].pass) {
        addMentionToInbox(mention, username, "DM", safeText);
        emitInbox(mention);
      }
    }

    io.to(username).emit("dm:message", { from: target, msg });
    io.to(target).emit("dm:message", { from: username, msg });

    me.stats.messages += 1;
    addXP(me, 10);
    scheduleSave();
  });

  // ---------- Groups ----------
  socket.on("groups:list", () => {
    const username = requireAuth();
    if (!username) return;
    emitGroupsList(username);
  });

  socket.on("groups:publicList", () => {
    const username = requireAuth();
    if (!username) return;

    const groups = Object.values(db.groups)
      .filter(g => g && g.active && (g.visibility || "private") === "public")
      .map(g => ({
        id: g.id,
        name: g.name,
        owner: g.owner,
        membersCount: (g.members || []).length,
        maxMembers: g.maxMembers || 50,
        visibility: g.visibility || "public"
      }))
      .sort((a,b)=> (b.membersCount - a.membersCount) || a.name.localeCompare(b.name))
      .slice(0, 80);

    io.to(username).emit("groups:publicList", { groups });
  });

  socket.on("group:create", ({ name, invites, visibility, maxMembers } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const vis = (visibility === "public") ? "public" : "private";
    let limit = Number(maxMembers);
    if (!Number.isFinite(limit)) limit = 50;
    limit = Math.max(2, Math.min(200, Math.floor(limit)));

    const gname = String(name || "").trim().slice(0, 40) || "Unnamed Group";
    const gid = crypto.randomBytes(6).toString("hex");

    if (vis === "public") {
      db.groups[gid] = {
        id: gid,
        name: gname,
        owner: username,
        members: [username],
        msgs: [],
        active: true,
        pendingInvites: [],
        visibility: "public",
        maxMembers: limit
      };

      emitGroupsList(username);
      scheduleSave();
      socket.emit("group:meta", {
        groupId: gid,
        meta: { id: gid, name: gname, owner: username, members: [username], visibility:"public", maxMembers: limit }
      });
      return;
    }

    // private: require at least 1 invite
    const list = Array.isArray(invites) ? invites.map(normalizeUser) : [];
    const uniqueInvites = Array.from(new Set(list))
      .filter(u => u && u !== username && db.users[u] && !db.users[u].guest && db.users[u].pass);

    if (uniqueInvites.length < 1) {
      socket.emit("sendError", { reason: "Invite at least 1 person for a private group." });
      return;
    }

    // respect allowGroupInvites: drop those who disabled invites
    const filteredInvites = uniqueInvites.filter(u => db.users[u].prefs?.allowGroupInvites !== false);
    if (filteredInvites.length < 1) {
      socket.emit("sendError", { reason: "No invited users are accepting group invites." });
      return;
    }

    db.groups[gid] = {
      id: gid,
      name: gname,
      owner: username,
      members: [username],
      msgs: [],
      active: false,
      pendingInvites: filteredInvites,
      visibility: "private",
      maxMembers: limit
    };

    for (const u of filteredInvites) {
      if (!db.groupInvites[u]) db.groupInvites[u] = [];
      db.groupInvites[u].unshift({ id: gid, from: username, name: gname, ts: now() });
      db.groupInvites[u] = db.groupInvites[u].slice(0, 50);
      emitInbox(u);
    }

    scheduleSave();
  });

  socket.on("groupInvite:accept", ({ id } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(id || "");
    const g = db.groups[gid];
    if (!g) return;

    // enforce limits
    const maxMembers = g.maxMembers || 50;
    if ((g.members || []).length >= maxMembers) {
      socket.emit("sendError", { reason: "Group is full." });
      return;
    }

    db.groupInvites[username] = (db.groupInvites[username] || []).filter(x => x.id !== gid);

    if (!g.members.includes(username)) g.members.push(username);
    if (!g.active) g.active = true;

    g.pendingInvites = (g.pendingInvites || []).filter(x => x !== username);

    for (const member of g.members) {
      io.to(member).emit("group:meta", {
        groupId: gid,
        meta: { id: gid, name: g.name, owner: g.owner, members: g.members, visibility: g.visibility || "private", maxMembers: g.maxMembers || 50 }
      });
      emitGroupsList(member);
      emitInbox(member);
    }

    scheduleSave();
  });

  socket.on("group:joinPublic", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || (g.visibility || "private") !== "public") {
      socket.emit("sendError", { reason: "Group not found." });
      return;
    }

    const maxMembers = g.maxMembers || 50;
    if ((g.members || []).length >= maxMembers) {
      socket.emit("sendError", { reason: "Group is full." });
      return;
    }

    if (!g.members.includes(username)) g.members.push(username);

    for (const m of g.members) {
      io.to(m).emit("group:meta", {
        groupId: gid,
        meta: { id: gid, name: g.name, owner: g.owner, members: g.members, visibility: "public", maxMembers: maxMembers }
      });
      emitGroupsList(m);
    }
    emitGroupsList(username);
    scheduleSave();
  });

  socket.on("group:history", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) {
      socket.emit("sendError", { reason: "No access to group." });
      return;
    }

    socket.emit("group:history", {
      groupId: gid,
      meta: { id: gid, name: g.name, owner: g.owner, members: g.members, visibility: g.visibility || "private", maxMembers: g.maxMembers || 50 },
      msgs: g.msgs.slice(-260)
    });
  });

  socket.on("group:send", ({ groupId, text } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) {
      socket.emit("sendError", { reason: "No access to group." });
      return;
    }

    let safeText = String(text || "").slice(0, 2000);
    if (shouldHardHide(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: username, text: safeText, ts: now() };
    g.msgs.push(msg);
    if (g.msgs.length > 380) g.msgs.shift();

    // mentions -> inbox
    for (const mention of extractMentions(safeText)) {
      if (db.users[mention] && !db.users[mention].guest && db.users[mention].pass) {
        addMentionToInbox(mention, username, `Group:${g.name}`, safeText);
        emitInbox(mention);
      }
    }

    for (const member of g.members) {
      io.to(member).emit("group:message", { groupId: gid, msg });
    }

    const me = db.users[username];
    me.stats.messages += 1;
    addXP(me, 9);
    scheduleSave();
  });

  socket.on("group:leave", ({ groupId } = {}) => {
    const username = requireAuth();
    if (!username) return;

    const gid = String(groupId || "");
    const g = db.groups[gid];
    if (!g || !g.active || !g.members.includes(username)) return;

    if (g.owner === username) {
      const members = [...g.members];
      delete db.groups[gid];
      for (const m of members) {
        io.to(m).emit("group:deleted", { groupId: gid });
        emitGroupsList(m);
      }
      scheduleSave();
      return;
    }

    g.members = g.members.filter(x => x !== username);
    io.to(username).emit("group:left", { groupId: gid });

    for (const m of g.members) {
      io.to(m).emit("group:meta", {
        groupId: gid,
        meta: { id: gid, name: g.name, owner: g.owner, members: g.members, visibility: g.visibility || "private", maxMembers: g.maxMembers || 50 }
      });
      emitGroupsList(m);
    }
    emitGroupsList(username);
    scheduleSave();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server listening on", PORT));

