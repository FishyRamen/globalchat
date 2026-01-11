/* server.js (new)
   Minimal Socket.IO + Express server implementing:
   - login/signup (username rules enforced)
   - token resume
   - global chat + dm + groups
   - group management (add/remove/leave/delete/rename/transfer)
   - friend requests + accept/decline/cancel/remove
   - block/unblock (server enforced for DMs + hides content)
   - profiles/stats + xp/levels (server authoritative)
   - content filtering placeholder (without shipping a big slur list)
*/

import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// ---------------- In-memory store (swap to DB later) ----------------
const users = new Map();        // username -> userRecord
const tokens = new Map();       // token -> username
const sockets = new Map();      // socket.id -> username or guest
const online = new Set();       // usernames online

const globalMsgs = [];          // {user,text,ts}
const dmMsgs = new Map();       // key "a|b" -> [{user,text,ts}]
const groups = new Map();       // gid -> {id,name,owner,members:Set,msgs:[]}

const MAX_GLOBAL_HISTORY = 150;
const MAX_GROUP_HISTORY = 200;
const MAX_DM_HISTORY = 200;

function safeNow(){ return Date.now(); }
function normUser(u){ return String(u || "").trim(); }

function hashPass(pw){
  // Simple PBKDF2; ok for a demo. Use bcrypt/argon2 in production.
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.pbkdf2Sync(String(pw), salt, 100000, 32, "sha256").toString("hex");
  return `${salt}:${derived}`;
}
function checkPass(pw, stored){
  const [salt, derived] = String(stored || "").split(":");
  if(!salt || !derived) return false;
  const test = crypto.pbkdf2Sync(String(pw), salt, 100000, 32, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(test), Buffer.from(derived));
}

function newToken(){
  return crypto.randomBytes(24).toString("hex");
}

function usernameValid(u){
  // No spaces, only letters/numbers/_/.
  // 3..20 chars (change if you want)
  return /^[A-Za-z0-9_.]{3,20}$/.test(u);
}

/* Content filtering
   You asked for “ban as much as possible”, including slurs and 18+ weirdness.
   I’m not going to paste huge slur lists here, but this gives you a single place
   to add more patterns safely.

   Rules:
   - If a message triggers HARD_BLOCK, it is replaced with "__HIDDEN_BY_FILTER__"
   - Mild words are allowed (user can optionally hide client-side)
*/
const HARD_BLOCK_PATTERNS = [
  // Threat-ish / doxx-ish / explicit harassment patterns (basic examples)
  /\b(kill\s+yourself|kys)\b/i,
  /\b(i\s+will\s+kill|i'm\s+gonna\s+kill)\b/i,
  /\b(address|phone\s*number|social\s*security)\b/i,
  // 18+ bait patterns (very rough)
  /\b(send\s+nudes|nude\s+pics|cp)\b/i,
];

function shouldHardBlock(text){
  const t = String(text || "");
  return HARD_BLOCK_PATTERNS.some(rx => rx.test(t));
}

function badUsername(text){
  // For username “bad words / 18+” filtering, reuse the same function.
  // Add more patterns here if you want stricter blocking.
  return shouldHardBlock(text);
}

function xpNext(level){
  // Increasing requirement: grows faster each level
  // level 1 => ~120, level 10 => bigger, etc.
  const base = 120;
  const growth = Math.floor(base * Math.pow(level, 1.45));
  return Math.max(base, growth);
}

function addXP(userRec, amount){
  userRec.xp = userRec.xp || { level:1, xp:0, next: xpNext(1) };
  userRec.xp.xp += amount;

  while(userRec.xp.xp >= userRec.xp.next){
    userRec.xp.xp -= userRec.xp.next;
    userRec.xp.level += 1;
    userRec.xp.next = xpNext(userRec.xp.level);
  }
}

function getUserRec(username){
  return users.get(username);
}

function userPublicProfile(username){
  const u = getUserRec(username);
  if(!u) return null;
  return {
    user: username,
    createdAt: u.createdAt,
    level: u.xp?.level ?? 1,
    xp: u.xp?.xp ?? 0,
    next: u.xp?.next ?? xpNext(1),
    messages: u.messages ?? 0,
    friendsCount: u.social?.friends?.length ?? 0
  };
}

function ensureUser(username, password){
  if(!users.has(username)){
    users.set(username, {
      username,
      pass: hashPass(password),
      createdAt: safeNow(),
      settings: { theme:"dark", density:0.55, sidebar:0.40, hideMildProfanity:false },
      social: { friends:[], incoming:[], outgoing:[], blocked:[] },
      xp: { level:1, xp:0, next: xpNext(1) },
      messages: 0
    });
  }
  return users.get(username);
}

function dmKey(a,b){
  const [x,y] = [a,b].sort((p,q)=>p.localeCompare(q));
  return `${x}|${y}`;
}

function emitOnline(){
  const list = Array.from(online).sort().map(u=>({ user:u }));
  io.emit("onlineUsers", list);
}

// "message pings" are simple counts; for a real app, track per-user unread.
// Here we just ping inbox count for requests.
function emitSocial(username){
  const u = getUserRec(username);
  if(!u) return;
  io.to(username).emit("social:update", u.social);
  io.to(username).emit("ping:update", {
    inbox: (u.social?.incoming?.length ?? 0),
    messages: 0
  });
}

// Rooms: join each username room for direct emits
function joinUserRoom(socket, username){
  socket.join(username);
}

// ---------------- Socket.IO ----------------
io.on("connection", (socket)=>{
  // helper: current username from socket
  function currentUser(){
    return sockets.get(socket.id) || null;
  }
  function requireAuth(){
    const u = currentUser();
    if(!u || u.startsWith("Guest")) return null;
    return u;
  }

  socket.on("resume", ({ token })=>{
    const username = tokens.get(token);
    if(!username || !users.has(username)){
      socket.emit("resumeFail");
      return;
    }
    sockets.set(socket.id, username);
    online.add(username);
    joinUserRoom(socket, username);

    const rec = getUserRec(username);
    socket.emit("loginSuccess", {
      username,
      guest:false,
      token,
      settings: rec.settings,
      social: rec.social,
      xp: rec.xp
    });

    socket.emit("settings", rec.settings);
    socket.emit("xp:update", rec.xp);

    emitSocial(username);
    emitOnline();
    socket.emit("groups:list", Array.from(groups.values())
      .filter(g=>g.members.has(username))
      .map(g=>({ id:g.id, name:g.name, owner:g.owner, members:Array.from(g.members) }))
    );
  });

  socket.on("login", ({ username, password, guest }={})=>{
    if(guest){
      const g = `Guest${Math.floor(Math.random()*1e9)}`;
      sockets.set(socket.id, g);
      socket.emit("loginSuccess", {
        username: g,
        guest:true,
        settings: { theme:"dark", density:0.55, sidebar:0.40, hideMildProfanity:false },
        social: { friends:[], incoming:[], outgoing:[], blocked:[] },
        xp: { level:1, xp:0, next: xpNext(1) }
      });
      return;
    }

    username = normUser(username);

    if(!usernameValid(username)){
      socket.emit("loginError", "Invalid username. Use letters/numbers/_/. only (3-20 chars). No spaces.");
      return;
    }
    if(badUsername(username)){
      socket.emit("loginError", "Username not allowed.");
      return;
    }
    if(!password || String(password).length < 4){
      socket.emit("loginError", "Password too short.");
      return;
    }

    let rec = users.get(username);
    if(!rec){
      // Create account
      rec = ensureUser(username, password);
    } else {
      // Login
      if(!checkPass(password, rec.pass)){
        socket.emit("loginError", "Wrong password.");
        return;
      }
    }

    const t = newToken();
    tokens.set(t, username);

    sockets.set(socket.id, username);
    online.add(username);
    joinUserRoom(socket, username);

    socket.emit("loginSuccess", {
      username,
      guest:false,
      token:t,
      settings: rec.settings,
      social: rec.social,
      xp: rec.xp
    });

    socket.emit("settings", rec.settings);
    socket.emit("xp:update", rec.xp);

    emitSocial(username);
    emitOnline();

    socket.emit("groups:list", Array.from(groups.values())
      .filter(g=>g.members.has(username))
      .map(g=>({ id:g.id, name:g.name, owner:g.owner, members:Array.from(g.members) }))
    );
  });

  socket.on("logout", ()=>{
    const u = currentUser();
    if(u && !u.startsWith("Guest")){
      online.delete(u);
      emitOnline();
    }
    sockets.delete(socket.id);
  });

  socket.on("disconnect", ()=>{
    const u = currentUser();
    if(u && !u.startsWith("Guest")){
      online.delete(u);
      emitOnline();
    }
    sockets.delete(socket.id);
  });

  // ---------- Settings ----------
  socket.on("settings:update", (s)=>{
    const username = requireAuth();
    if(!username) return;
    const u = getUserRec(username);
    if(!u) return;
    u.settings = {
      theme: String(s?.theme || "dark"),
      density: Number.isFinite(s?.density) ? s.density : 0.55,
      sidebar: Number.isFinite(s?.sidebar) ? s.sidebar : 0.40,
      hideMildProfanity: !!s?.hideMildProfanity
    };
    io.to(username).emit("settings", u.settings);
  });

  socket.on("social:sync", ()=>{
    const username = requireAuth();
    if(!username) return;
    emitSocial(username);
  });

  // ---------- Global chat ----------
  socket.on("requestGlobalHistory", ()=>{
    socket.emit("history", globalMsgs.slice(-MAX_GLOBAL_HISTORY));
  });

  socket.on("sendGlobal", ({ text, ts }={})=>{
    const sender = currentUser();
    if(!sender) return;

    // Guests can talk, but still filtered
    if(shouldHardBlock(text)){
      // don't broadcast content
      const msg = { user: sender, text: "__HIDDEN_BY_FILTER__", ts: safeNow() };
      globalMsgs.push(msg);
      io.emit("globalMessage", msg);
      return;
    }

    const msg = { user: sender, text: String(text||"").slice(0, 2000), ts: Number(ts)||safeNow() };
    globalMsgs.push(msg);
    if(globalMsgs.length > MAX_GLOBAL_HISTORY) globalMsgs.shift();
    io.emit("globalMessage", msg);

    // XP only for real users
    if(!sender.startsWith("Guest")){
      const u = getUserRec(sender);
      u.messages = (u.messages || 0) + 1;
      addXP(u, 8); // global message xp
      io.to(sender).emit("xp:update", u.xp);
    }
  });

  // ---------- DMs ----------
  socket.on("dm:history", ({ withUser }={})=>{
    const sender = requireAuth();
    if(!sender) return;

    const other = normUser(withUser);
    const key = dmKey(sender, other);
    const msgs = dmMsgs.get(key) || [];
    socket.emit("dm:history", { withUser: other, msgs: msgs.slice(-MAX_DM_HISTORY) });
  });

  socket.on("dm:send", ({ to, text }={})=>{
    const sender = requireAuth();
    if(!sender) return;

    const target = normUser(to);
    if(!users.has(target)){
      socket.emit("sendError", { reason:"User not found." });
      return;
    }

    const sRec = getUserRec(sender);
    const tRec = getUserRec(target);

    // Block enforcement
    if(sRec.social.blocked.includes(target) || tRec.social.blocked.includes(sender)){
      socket.emit("sendError", { reason:"You can’t message this user." });
      return;
    }

    let safeText = String(text||"").slice(0, 2000);
    if(shouldHardBlock(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: sender, text: safeText, ts: safeNow() };

    const key = dmKey(sender, target);
    if(!dmMsgs.has(key)) dmMsgs.set(key, []);
    dmMsgs.get(key).push(msg);
    if(dmMsgs.get(key).length > MAX_DM_HISTORY) dmMsgs.get(key).shift();

    // deliver to both
    io.to(sender).emit("dm:message", { from: target, msg }); // sender sees it in that thread
    io.to(target).emit("dm:message", { from: sender, msg });

    sRec.messages = (sRec.messages || 0) + 1;
    addXP(sRec, 10); // DM message xp
    io.to(sender).emit("xp:update", sRec.xp);
  });

  // ---------- Groups ----------
  socket.on("groups:list", ()=>{
    const username = requireAuth();
    if(!username) return;
    socket.emit("groups:list", Array.from(groups.values())
      .filter(g=>g.members.has(username))
      .map(g=>({ id:g.id, name:g.name, owner:g.owner, members:Array.from(g.members) }))
    );
  });

  socket.on("group:create", ({ name }={})=>{
    const username = requireAuth();
    if(!username) return;

    const gname = String(name||"").trim().slice(0, 40);
    if(!gname){
      socket.emit("sendError", { reason:"Group name required." });
      return;
    }

    const id = crypto.randomBytes(6).toString("hex"); // not a random number string in UI; UI uses name
    const g = {
      id,
      name: gname,
      owner: username,
      members: new Set([username]),
      msgs: []
    };
    groups.set(id, g);

    socket.emit("groups:list", Array.from(groups.values())
      .filter(x=>x.members.has(username))
      .map(x=>({ id:x.id, name:x.name, owner:x.owner, members:Array.from(x.members) }))
    );
  });

  socket.on("group:history", ({ groupId }={})=>{
    const username = requireAuth();
    if(!username) return;
    const g = groups.get(groupId);
    if(!g || !g.members.has(username)){
      socket.emit("sendError", { reason:"No access to group." });
      return;
    }
    socket.emit("group:history", {
      groupId: g.id,
      meta: { id:g.id, name:g.name, owner:g.owner, members:Array.from(g.members) },
      msgs: g.msgs.slice(-MAX_GROUP_HISTORY)
    });
  });

  socket.on("group:send", ({ groupId, text }={})=>{
    const username = requireAuth();
    if(!username) return;
    const g = groups.get(groupId);
    if(!g || !g.members.has(username)){
      socket.emit("sendError", { reason:"No access to group." });
      return;
    }

    let safeText = String(text||"").slice(0, 2000);
    if(shouldHardBlock(safeText)) safeText = "__HIDDEN_BY_FILTER__";

    const msg = { user: username, text: safeText, ts: safeNow() };
    g.msgs.push(msg);
    if(g.msgs.length > MAX_GROUP_HISTORY) g.msgs.shift();

    // broadcast to all group members
    for(const member of g.members){
      io.to(member).emit("group:message", { groupId: g.id, msg });
    }

    const u = getUserRec(username);
    u.messages = (u.messages || 0) + 1;
    addXP(u, 9); // group message xp
    io.to(username).emit("xp:update", u.xp);
  });

  socket.on("group:addMember", ({ groupId, user }={})=>{
    const username = requireAuth();
    if(!username) return;
    const g = groups.get(groupId);
    const target = normUser(user);

    if(!g || g.owner !== username){
      socket.emit("sendError", { reason:"Only owner can add members." });
      return;
    }
    if(!users.has(target)){
      socket.emit("sendError", { reason:"User not found." });
      return;
    }

    g.members.add(target);

    // notify members with updated meta
    const meta = { id:g.id, name:g.name, owner:g.owner, members:Array.from(g.members) };
    for(const member of g.members){
      io.to(member).emit("group:meta", { groupId:g.id, meta });
    }
    // refresh list for added user
    io.to(target).emit("groups:list", Array.from(groups.values())
      .filter(x=>x.members.has(target))
      .map(x=>({ id:x.id, name:x.name, owner:x.owner, members:Array.from(x.members) }))
    );
  });

  socket.on("group:removeMember", ({ groupId, user }={})=>{
    const username = requireAuth();
    if(!username) return;
    const g = groups.get(groupId);
    const target = normUser(user);

    if(!g || g.owner !== username){
      socket.emit("sendError", { reason:"Only owner can remove members." });
      return;
    }
    if(target === g.owner){
      socket.emit("sendError", { reason:"Owner can’t be removed." });
      return;
    }
    g.members.delete(target);

    const meta = { id:g.id, name:g.name, owner:g.owner, members:Array.from(g.members) };
    for(const member of g.members){
      io.to(member).emit("group:meta", { groupId:g.id, meta });
    }
    io.to(target).emit("group:left", { groupId:g.id });
    io.to(target).emit("groups:list", Array.from(groups.values())
      .filter(x=>x.members.has(target))
      .map(x=>({ id:x.id, name:x.name, owner:x.owner, members:Array.from(x.members) }))
    );
  });

  socket.on("group:leave", ({ groupId }={})=>{
    const username = requireAuth();
    if(!username) return;
    const g = groups.get(groupId);
    if(!g || !g.members.has(username)) return;

    // If owner leaves, delete group (simple rule; can change if you want)
    if(g.owner === username){
      groups.delete(groupId);
      // notify old members
      for(const member of g.members){
        io.to(member).emit("group:deleted", { groupId });
        io.to(member).emit("groups:list", Array.from(groups.values())
          .filter(x=>x.members.has(member))
          .map(x=>({ id:x.id, name:x.name, owner:x.owner, members:Array.from(x.members) }))
        );
      }
      return;
    }

    g.members.delete(username);
    io.to(username).emit("group:left", { groupId });

    const meta = { id:g.id, name:g.name, owner:g.owner, members:Array.from(g.members) };
    for(const member of g.members){
      io.to(member).emit("group:meta", { groupId:g.id, meta });
    }
    io.to(username).emit("groups:list", Array.from(groups.values())
      .filter(x=>x.members.has(username))
      .map(x=>({ id:x.id, name:x.name, owner:x.owner, members:Array.from(x.members) }))
    );
  });

  socket.on("group:delete", ({ groupId }={})=>{
    const username = requireAuth();
    if(!username) return;
    const g = groups.get(groupId);
    if(!g || g.owner !== username){
      socket.emit("sendError", { reason:"Only owner can delete group." });
      return;
    }
    groups.delete(groupId);
    for(const member of g.members){
      io.to(member).emit("group:deleted", { groupId });
      io.to(member).emit("groups:list", Array.from(groups.values())
        .filter(x=>x.members.has(member))
        .map(x=>({ id:x.id, name:x.name, owner:x.owner, members:Array.from(x.members) }))
      );
    }
  });

  socket.on("group:transferOwner", ({ groupId, newOwner }={})=>{
    const username = requireAuth();
    if(!username) return;
    const g = groups.get(groupId);
    const target = normUser(newOwner);

    if(!g || g.owner !== username){
      socket.emit("sendError", { reason:"Only owner can transfer." });
      return;
    }
    if(!g.members.has(target)){
      socket.emit("sendError", { reason:"New owner must be a member." });
      return;
    }
    g.owner = target;

    const meta = { id:g.id, name:g.name, owner:g.owner, members:Array.from(g.members) };
    for(const member of g.members){
      io.to(member).emit("group:meta", { groupId:g.id, meta });
    }
  });

  socket.on("group:rename", ({ groupId, name }={})=>{
    const username = requireAuth();
    if(!username) return;
    const g = groups.get(groupId);
    if(!g || g.owner !== username){
      socket.emit("sendError", { reason:"Only owner can rename." });
      return;
    }
    const n = String(name||"").trim().slice(0, 40);
    if(!n){
      socket.emit("sendError", { reason:"Name required." });
      return;
    }
    g.name = n;
    const meta = { id:g.id, name:g.name, owner:g.owner, members:Array.from(g.members) };
    for(const member of g.members){
      io.to(member).emit("group:meta", { groupId:g.id, meta });
      io.to(member).emit("groups:list", Array.from(groups.values())
        .filter(x=>x.members.has(member))
        .map(x=>({ id:x.id, name:x.name, owner:x.owner, members:Array.from(x.members) }))
      );
    }
  });

  // ---------- Friends ----------
  socket.on("friend:request", ({ to }={})=>{
    const username = requireAuth();
    if(!username) return;
    const target = normUser(to);

    if(!users.has(target)){
      socket.emit("sendError", { reason:"User not found." });
      return;
    }
    if(target === username){
      socket.emit("sendError", { reason:"You can’t friend yourself." });
      return;
    }

    const meRec = getUserRec(username);
    const tRec = getUserRec(target);

    if(meRec.social.blocked.includes(target) || tRec.social.blocked.includes(username)){
      socket.emit("sendError", { reason:"Blocked." });
      return;
    }

    if(meRec.social.friends.includes(target)){
      socket.emit("sendError", { reason:"Already friends." });
      return;
    }

    if(meRec.social.outgoing.includes(target)){
      socket.emit("sendError", { reason:"Request already sent." });
      return;
    }

    meRec.social.outgoing.push(target);
    tRec.social.incoming.push(username);

    emitSocial(username);
    emitSocial(target);
  });

  socket.on("friend:accept", ({ from }={})=>{
    const username = requireAuth();
    if(!username) return;
    const src = normUser(from);

    const meRec = getUserRec(username);
    const sRec = getUserRec(src);
    if(!sRec) return;

    // remove incoming/outgoing
    meRec.social.incoming = meRec.social.incoming.filter(x=>x!==src);
    sRec.social.outgoing = sRec.social.outgoing.filter(x=>x!==username);

    if(!meRec.social.friends.includes(src)) meRec.social.friends.push(src);
    if(!sRec.social.friends.includes(username)) sRec.social.friends.push(username);

    emitSocial(username);
    emitSocial(src);
  });

  socket.on("friend:decline", ({ from }={})=>{
    const username = requireAuth();
    if(!username) return;
    const src = normUser(from);
    const meRec = getUserRec(username);
    const sRec = getUserRec(src);
    if(!sRec) return;

    meRec.social.incoming = meRec.social.incoming.filter(x=>x!==src);
    sRec.social.outgoing = sRec.social.outgoing.filter(x=>x!==username);

    emitSocial(username);
    emitSocial(src);
  });

  socket.on("friend:cancel", ({ to }={})=>{
    const username = requireAuth();
    if(!username) return;
    const target = normUser(to);
    const meRec = getUserRec(username);
    const tRec = getUserRec(target);
    if(!tRec) return;

    meRec.social.outgoing = meRec.social.outgoing.filter(x=>x!==target);
    tRec.social.incoming = tRec.social.incoming.filter(x=>x!==username);

    emitSocial(username);
    emitSocial(target);
  });

  socket.on("friend:remove", ({ user }={})=>{
    const username = requireAuth();
    if(!username) return;
    const target = normUser(user);
    const meRec = getUserRec(username);
    const tRec = getUserRec(target);
    if(!tRec) return;

    meRec.social.friends = meRec.social.friends.filter(x=>x!==target);
    tRec.social.friends = tRec.social.friends.filter(x=>x!==username);

    emitSocial(username);
    emitSocial(target);
  });

  // ---------- Blocking ----------
  socket.on("user:block", ({ user }={})=>{
    const username = requireAuth();
    if(!username) return;
    const target = normUser(user);
    const meRec = getUserRec(username);
    if(!users.has(target)) return;

    if(!meRec.social.blocked.includes(target)){
      meRec.social.blocked.push(target);
    }
    // Optional: remove friendship + pending requests automatically
    meRec.social.friends = meRec.social.friends.filter(x=>x!==target);
    meRec.social.incoming = meRec.social.incoming.filter(x=>x!==target);
    meRec.social.outgoing = meRec.social.outgoing.filter(x=>x!==target);

    const tRec = getUserRec(target);
    tRec.social.friends = tRec.social.friends.filter(x=>x!==username);
    tRec.social.incoming = tRec.social.incoming.filter(x=>x!==username);
    tRec.social.outgoing = tRec.social.outgoing.filter(x=>x!==username);

    emitSocial(username);
    emitSocial(target);
  });

  socket.on("user:unblock", ({ user }={})=>{
    const username = requireAuth();
    if(!username) return;
    const target = normUser(user);
    const meRec = getUserRec(username);
    meRec.social.blocked = meRec.social.blocked.filter(x=>x!==target);
    emitSocial(username);
  });

  // ---------- Profile ----------
  socket.on("profile:get", ({ user }={})=>{
    const requester = currentUser();
    if(!requester) return;

    const target = normUser(user);
    if(target.startsWith("Guest")){
      socket.emit("profile:data", {
        user: target,
        createdAt: safeNow(),
        level: 1,
        xp: 0,
        next: xpNext(1),
        messages: 0,
        friendsCount: 0
      });
      return;
    }

    const p = userPublicProfile(target);
    if(!p){
      socket.emit("sendError", { reason:"Profile not found." });
      return;
    }
    socket.emit("profile:data", p);
  });
});

// ---------------- Start ----------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log("Server running on port", PORT));
