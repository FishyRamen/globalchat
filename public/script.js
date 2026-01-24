/* public/script.js
   - Inbox is a topbar icon (not inside the dropdown)
   - Dynamic loading screen transitions (login/guest/logout)
   - Settings: sounds, profanity mask, friend requests, group invites/requests, custom cursor toggle
   - Guests: no inbox, cannot be friended, account menu shows Log in instead of Log out, no profile/inbox/leaderboard
   - Groups: create public/private, discover public groups, join/request private groups, owner tools: cooldown + mute user + mute all
   - Global cooldown is dynamic (server tells client)
*/

const socket = io();
const $ = (id) => document.getElementById(id);

// DOM
const loginOverlay = $("loginOverlay");
const loading = $("loading");
const loaderSub = $("loaderSub");

const usernameEl = $("username");
const passwordEl = $("password");
const joinBtn = $("joinBtn");
const guestBtn = $("guestBtn");
const togglePass = $("togglePass");

const channelList = $("channelList");
const onlineList = $("onlineList");

const topicTitle = $("topicTitle");
const topicSub = $("topicSub");

const mePill = $("mePill");
const meName = $("meName");
const meDot = $("meDot");

const inboxBtnWrap = $("inboxBtnWrap");
const inboxBtn = $("inboxBtn");
const inboxBadgeMini = $("inboxBadgeMini");

const chat = $("chat");
const messageEl = $("message");
const sendBtn = $("sendBtn");
const hintLeft = $("hintLeft");
const hintRight = $("hintRight");

const createGroupBtn = $("createGroupBtn");
const discoverGroupsBtn = $("discoverGroupsBtn");

const modalBack = $("modalBack");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
const modalClose = $("modalClose");

const yearEl = $("year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

// Cursor
const cursor = $("cursor");
const cursor2 = $("cursor2");

// State
let token = localStorage.getItem("tonkotsu_token") || "";
let me = null;
let isGuest = false;

let settings = {
  sounds: true,
  hideMildProfanity: false,
  allowFriendRequests: true,
  allowGroupInvites: true,
  customCursor: true
};

let social = { friends: [], incoming: [], outgoing: [], blocked: [] };
let myStatus = "online";

let inboxCounts = { total: 0, friend: 0, groupInv: 0, ment: 0, groupReq: 0 };
let inboxItems = [];

let onlineUsers = [];

let globalCache = [];
let dmCache = new Map();      // user -> msgs
let groupCache = new Map();   // groupId -> msgs
let groupMeta = new Map();    // groupId -> meta

let view = { type: "global", id: null }; // global | dm | group
let cooldownUntil = 0;
let cooldownSec = 3;          // server-driven
let manualStatus = false;
let lastActivity = Date.now();

// per-refresh color assignment
const sessionSeed = Math.floor(Math.random() * 1e9).toString(16);

// ---------- helpers ----------
function now() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function esc(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function fmtTime(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
}
function isValidUser(u) { return /^[A-Za-z0-9]{4,20}$/.test(String(u||"").trim()); }
function isValidPass(p) { return /^[A-Za-z0-9]{4,32}$/.test(String(p||"").trim()); }

function dotClass(st){
  if (st === "online") return "online";
  if (st === "idle") return "idle";
  if (st === "dnd") return "dnd";
  return "offline";
}
function statusLabel(st){
  if (st === "online") return "Online";
  if (st === "idle") return "Idle";
  if (st === "dnd") return "Do Not Disturb";
  if (st === "invisible") return "Offline";
  return "Offline";
}

const MILD_WORDS = ["fuck","fucking","shit","shitty","asshole","bitch","bastard","dick","pussy"];
const MILD_RX = new RegExp(`\\b(${MILD_WORDS.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})\\b`, "ig");
function maybeHideMild(text) {
  if (!settings?.hideMildProfanity) return text;
  return String(text).replace(MILD_RX, "•••");
}

function isBlockedUser(u){
  return !!social?.blocked?.includes(u);
}

// random-but-stable-per-refresh user color
function hash32(str) {
  let h = 2166136261;
  for (let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}
function userColor(username){
  const h = hash32(`${sessionSeed}:${username}`);
  const hue = h % 360;
  const sat = 62 + (h % 18);
  const light = 58 + ((h >> 8) % 10);
  return `hsl(${hue} ${sat}% ${light}%)`;
}

// ---------- cursor ----------
function applyCursorSetting(){
  const on = settings?.customCursor !== false;
  document.body.style.cursor = on ? "none" : "auto";
  if (cursor) cursor.style.display = on ? "block" : "none";
  if (cursor2) cursor2.style.display = on ? "block" : "none";
}
(function initCursor(){
  if (!cursor || !cursor2) return;

  let x = innerWidth/2, y = innerHeight/2;
  let x2 = x, y2 = y;

  function show(on){
    if (settings?.customCursor === false) return;
    cursor.style.opacity = on ? "1" : "0";
    cursor2.style.opacity = on ? "1" : "0";
  }
  show(true);

  addEventListener("mouseenter", ()=> show(true));
  addEventListener("mouseleave", ()=> show(false));
  addEventListener("mousemove", (e)=>{ x=e.clientX; y=e.clientY; }, { passive:true });

  addEventListener("mousedown", ()=> document.body.classList.add("cursorPress"));
  addEventListener("mouseup", ()=> document.body.classList.remove("cursorPress"));

  function tick(){
    x2 += (x-x2)*0.18;
    y2 += (y-y2)*0.18;
    cursor.style.transform = `translate(${x}px, ${y}px) translate(-50%,-50%)`;
    cursor2.style.transform = `translate(${x2}px, ${y2}px) translate(-50%,-50%)`;
    requestAnimationFrame(tick);
  }
  tick();

  function bindHover(){
    document.querySelectorAll(".btn,.item,.onlineRow,.topicTitle.clickable,a,.user").forEach(el=>{
      if (el.__h) return;
      el.__h = true;
      el.addEventListener("mouseenter", ()=> document.body.classList.add("cursorHover"));
      el.addEventListener("mouseleave", ()=> document.body.classList.remove("cursorHover"));
    });
    document.querySelectorAll("input,textarea,.field,select").forEach(el=>{
      if (el.__t) return;
      el.__t = true;
      el.addEventListener("mouseenter", ()=> document.body.classList.add("cursorText"));
      el.addEventListener("mouseleave", ()=> document.body.classList.remove("cursorText"));
    });
  }
  window.__bindHover = bindHover;
  bindHover();
})();

// ---------- ripple ----------
function attachRipple(root=document){
  root.querySelectorAll(".btn,.item,.onlineRow").forEach(el=>{
    if (el.__r) return;
    el.__r = true;
    el.addEventListener("pointerdown",(e)=>{
      if (el.disabled) return;
      const r = document.createElement("span");
      r.className = "ripple";
      const rect = el.getBoundingClientRect();
      r.style.left = (e.clientX - rect.left) + "px";
      r.style.top = (e.clientY - rect.top) + "px";
      el.appendChild(r);
      setTimeout(()=> r.remove(), 520);
    }, { passive:true });
  });
  window.__bindHover?.();
}
attachRipple();

// ---------- loading ----------
function showLoading(text="Loading…"){
  if (loaderSub) loaderSub.textContent = text;
  if (loading) loading.classList.add("show");
}
function hideLoading(){
  if (loading) loading.classList.remove("show");
}

// ---------- modal ----------
function openModal(title, html){
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalBack.classList.add("show");
  attachRipple(modalBody);
}
function closeModal(){
  modalBack.classList.remove("show");
  modalBody.innerHTML = "";
}
modalClose?.addEventListener("click", closeModal);
modalBack?.addEventListener("click", (e)=>{ if(e.target===modalBack) closeModal(); });

// ---------- satisfying pings ----------
let audioCtx = null;
function ensureAudio(){
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume().catch(()=>{});
  return audioCtx;
}
function canNotify(){
  if (myStatus === "dnd") return false;
  if (myStatus === "invisible") return false;
  return true;
}
function pingSound(kind="default"){
  if (!settings?.sounds) return;
  if (!canNotify()) return;

  try{
    const ctx = ensureAudio();
    const t0 = ctx.currentTime;

    // pleasant 2-tone + soft click
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.exponentialRampToValueAtTime(0.06, t0 + 0.01);
    master.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
    master.connect(ctx.destination);

    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g1 = ctx.createGain();
    const g2 = ctx.createGain();

    o1.type = "sine";
    o2.type = "triangle";

    const a = (kind === "mention") ? 880 : (kind === "dm" ? 740 : 780);
    const b = (kind === "mention") ? 1175 : (kind === "dm" ? 988 : 1046);

    o1.frequency.setValueAtTime(a, t0);
    o1.frequency.exponentialRampToValueAtTime(a * 0.985, t0 + 0.12);

    o2.frequency.setValueAtTime(b, t0 + 0.02);
    o2.frequency.exponentialRampToValueAtTime(b * 0.98, t0 + 0.14);

    g1.gain.setValueAtTime(0.0001, t0);
    g1.gain.exponentialRampToValueAtTime(0.6, t0 + 0.01);
    g1.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);

    g2.gain.setValueAtTime(0.0001, t0 + 0.02);
    g2.gain.exponentialRampToValueAtTime(0.45, t0 + 0.03);
    g2.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);

    o1.connect(g1); g1.connect(master);
    o2.connect(g2); g2.connect(master);

    o1.start(t0);
    o2.start(t0 + 0.02);

    o1.stop(t0 + 0.2);
    o2.stop(t0 + 0.2);
  }catch{}
}

// ---------- cooldown ----------
function canSend(){ return now() >= cooldownUntil; }
function startCooldown(){
  cooldownUntil = now() + Math.max(0.8, Number(cooldownSec || 3)) * 1000;
}
function updateHints(){
  hintLeft.textContent = `Cooldown: ${Number(cooldownSec || 3).toFixed(1)}s`;
  hintRight.textContent = `Status: ${statusLabel(myStatus)}`;
  meDot.className = `dot ${dotClass(myStatus === "invisible" ? "offline" : myStatus)}`;
}

// ---------- idle auto (3 min) ----------
function markActivity(){
  lastActivity = now();
  if (!manualStatus && myStatus === "idle") {
    socket.emit("status:set", { status: "online" });
  }
}
["mousemove","keydown","mousedown","touchstart","scroll"].forEach(evt=>{
  addEventListener(evt, markActivity, { passive:true });
});
function idleLoop(){
  if (me && !isGuest && !manualStatus) {
    const inactive = now() - lastActivity;
    if (myStatus === "online" && inactive >= 180000) {
      socket.emit("status:set", { status: "idle" });
    }
  }
  setTimeout(idleLoop, 1000);
}

// ---------- view ----------
function setView(type, id=null){
  view = { type, id };

  topicTitle.classList.remove("clickable");
  topicTitle.onclick = null;

  if (type === "global"){
    topicTitle.textContent = "# global";
    topicSub.textContent = "everyone";
  } else if (type === "dm"){
    topicTitle.textContent = `@ ${id}`;
    topicSub.textContent = "direct messages";
  } else if (type === "group"){
    const meta = groupMeta.get(id);
    topicTitle.textContent = meta ? `# ${meta.name}` : "# group";
    topicSub.textContent = meta ? `${meta.privacy || "private"} • group chat` : "group chat";
    topicTitle.classList.add("clickable");
    topicTitle.onclick = ()=> openGroupInfo(id);
  }
  window.__bindHover?.();
}

function clearChat(){ chat.innerHTML = ""; }

function renderTextWithMentions(text){
  const safe = esc(text);
  if (!me) return safe;
  const rx = new RegExp(`(@${me.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`, "ig");
  return safe.replace(rx, `<span class="mention">$1</span>`);
}

function addMessageToUI({ user, text, ts }, scope){
  let content = String(text ?? "");
  const blocked = (scope === "global" && user && isBlockedUser(user));

  if (!blocked) content = maybeHideMild(content);

  const div = document.createElement("div");
  div.className = "msg";

  const color = userColor(user || "user");
  const nameHtml = `<span class="user" data-user="${esc(user)}" style="color:${color}">${esc(user)}</span>`;

  const bodyHtml = blocked
    ? `<div class="text" style="filter:blur(7px);opacity:.55">Message hidden (blocked user)</div>
       <div style="margin-top:8px"><button class="btn small primary" data-reveal="1">Reveal</button></div>`
    : `<div class="text">${renderTextWithMentions(content)}</div>`;

  div.innerHTML = `
    <div class="bubble">
      <div class="meta">
        ${nameHtml}
        <div class="time">${esc(fmtTime(ts))}</div>
      </div>
      ${bodyHtml}
    </div>
  `;

  div.querySelector(".user")?.addEventListener("click", ()=>{
    openProfile(div.querySelector(".user").getAttribute("data-user"));
  });

  div.querySelector('[data-reveal="1"]')?.addEventListener("click", ()=>{
    const b = div.querySelector(".text");
    b.style.filter = "none";
    b.style.opacity = "1";
    b.innerHTML = renderTextWithMentions(maybeHideMild(String(text ?? "")));
    div.querySelector('[data-reveal="1"]').remove();
  });

  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  attachRipple(div);
  window.__bindHover?.();
}

// ---------- sidebar rendering ----------
let activeKey = "global";
function setActive(key){
  activeKey = key;
  channelList.querySelectorAll(".item").forEach(el=>{
    el.classList.toggle("active", el.getAttribute("data-key") === key);
  });
}

function renderChannels(){
  const items = [];

  // Global
  items.push({
    key: "global",
    type: "global",
    label: "global",
    sub: "everyone",
    badge: inboxCounts?.ment || 0
  });

  // DMs
  const dmUsers = Array.from(dmCache.keys()).sort((a,b)=>a.localeCompare(b));
  for (const u of dmUsers){
    items.push({ key:`dm:${u}`, type:"dm", id:u, label:u, sub:"dm", badge:0 });
  }

  // Groups (only ones you're in)
  const groups = Array.from(groupMeta.values()).sort((a,b)=>String(a.name).localeCompare(String(b.name)));
  for (const g of groups){
    items.push({
      key:`grp:${g.id}`,
      type:"group",
      id:g.id,
      label:g.name,
      sub:`${(g.members||[]).length} members • ${g.privacy || "private"}`,
      badge:0
    });
  }

  channelList.innerHTML = items.map(it=>{
    const badgeNum = Number(it.badge || 0);
    return `
      <div class="item" data-key="${esc(it.key)}" data-type="${esc(it.type)}" data-id="${esc(it.id||"")}">
        <div class="left">
          <div class="hash">${it.type === "dm" ? "@" : "#"}</div>
          <div class="nameCol">
            <div class="name">${esc(it.label)}</div>
            <div class="sub">${esc(it.sub)}</div>
          </div>
        </div>
        <div class="badge ${badgeNum>0?"show":""}" style="display:${badgeNum>0?"flex":"none"}">${badgeNum}</div>
      </div>
    `;
  }).join("");

  channelList.querySelectorAll(".item").forEach(el=>{
    el.addEventListener("click", ()=>{
      const t = el.getAttribute("data-type");
      const id = el.getAttribute("data-id") || null;

      if (t === "global") openGlobal();
      if (t === "dm") openDM(id);
      if (t === "group") openGroup(id);
    });
  });

  setActive(activeKey);
  attachRipple(channelList);
}

function renderOnline(){
  onlineList.innerHTML = onlineUsers.map(u=>{
    const st = u.status || "online";
    return `
      <div class="onlineRow" data-user="${esc(u.user)}">
        <div style="display:flex;align-items:center;gap:10px;min-width:0">
          <div class="dot ${esc(dotClass(st))}"></div>
          <div style="min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${userColor(u.user)};font-weight:950">${esc(u.user)}</div>
        </div>
        <div class="tiny muted">Lv ${esc(u.level || 1)}</div>
      </div>
    `;
  }).join("");

  onlineList.querySelectorAll(".onlineRow").forEach(el=>{
    el.addEventListener("click", ()=> openProfile(el.getAttribute("data-user")));
  });

  attachRipple(onlineList);
}

// ---------- open views ----------
function openGlobal(){
  showLoading("Opening #global…");
  setTimeout(()=>{
    setView("global");
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, "global"));
    socket.emit("requestGlobalHistory");
    activeKey = "global";
    renderChannels();
    hideLoading();
  }, 160);
}

function openDM(user){
  if (isGuest) {
    openModal("DMs", `<div class="muted">Guests can’t use DMs. Log in to DM.</div>`);
    return;
  }
  if (!user) return;

  showLoading("Opening DM…");
  setTimeout(()=>{
    setView("dm", user);
    clearChat();
    socket.emit("dm:history", { withUser: user });
    activeKey = `dm:${user}`;
    renderChannels();
    hideLoading();
  }, 160);
}

function openGroup(gid){
  if (isGuest) {
    openModal("Groups", `<div class="muted">Guests can’t use groups. Log in to join groups.</div>`);
    return;
  }
  if (!gid) return;

  showLoading("Opening group…");
  setTimeout(()=>{
    setView("group", gid);
    clearChat();
    socket.emit("group:history", { groupId: gid });
    activeKey = `grp:${gid}`;
    renderChannels();
    hideLoading();
  }, 160);
}

// ---------- send ----------
function sendCurrent(){
  if (!me) return;
  const text = (messageEl.value || "").trim();
  if (!text) return;

  if (!canSend()) return;
  startCooldown();
  messageEl.value = "";

  if (view.type === "global") socket.emit("sendGlobal", { text });
  if (view.type === "dm") socket.emit("dm:send", { to: view.id, text });
  if (view.type === "group") socket.emit("group:send", { groupId: view.id, text });
}
sendBtn.addEventListener("click", sendCurrent);
messageEl.addEventListener("keydown",(e)=>{
  if (e.key === "Enter" && !e.shiftKey){
    e.preventDefault();
    sendCurrent();
  }
});

// ---------- account menu ----------
function openAccountMenu(){
  if (!me) return;

  if (isGuest){
    openModal("Guest", `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
          <div style="font-weight:950;color:${userColor(me)}">${esc(me)} (Guest)</div>
          <div class="muted tiny" style="margin-top:6px">Status: <b style="color:var(--text)">${esc(statusLabel(myStatus))}</b></div>
        </div>

        <button class="btn" id="btnSettings">Settings</button>

        <div style="height:1px;background:rgba(255,255,255,.08);margin:6px 0"></div>

        <button class="btn primary" id="btnLogin">Log in</button>
      </div>
    `);

    $("btnSettings").onclick = ()=>{ closeModal(); openSettings(); };
    $("btnLogin").onclick = ()=>{ showLoading("Returning to login…"); setTimeout(()=> location.reload(), 250); };
    return;
  }

  openModal("Account", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;color:${userColor(me)}">${esc(me)}</div>
        <div class="muted tiny" style="margin-top:6px">Status: <b style="color:var(--text)">${esc(statusLabel(myStatus))}</b></div>
      </div>

      <button class="btn primary" id="btnProfile">Profile</button>
      <button class="btn" id="btnSettings">Settings</button>
      <button class="btn" id="btnLb">Leaderboard</button>

      <div style="height:1px;background:rgba(255,255,255,.08);margin:6px 0"></div>

      <button class="btn" id="btnLogout" style="border-color:rgba(255,77,77,.25)">Log out</button>
    </div>
  `);

  $("btnProfile").onclick = ()=>{ closeModal(); openProfile(me); };
  $("btnSettings").onclick = ()=>{ closeModal(); openSettings(); };
  $("btnLb").onclick = ()=>{ closeModal(); openLeaderboard(); };
  $("btnLogout").onclick = ()=> doLogout();
}

function doLogout(){
  showLoading("Logging out…");
  setTimeout(()=>{
    localStorage.removeItem("tonkotsu_token");
    location.reload();
  }, 260);
}

mePill.addEventListener("click", openAccountMenu);

// ---------- inbox icon ----------
inboxBtn?.addEventListener("click", ()=>{
  if (isGuest) return;
  openInbox();
});

// ---------- inbox ----------
function openInbox(){
  if (isGuest) return openModal("Inbox", `<div class="muted">Guest mode has no inbox.</div>`);
  socket.emit("inbox:get");

  const mentions = inboxItems.filter(x=>x.type==="mention");
  const friendReq = inboxItems.filter(x=>x.type==="friend");
  const groupInv = inboxItems.filter(x=>x.type==="group");
  const groupReq = inboxItems.filter(x=>x.type==="groupReq");

  openModal("Inbox", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div class="muted tiny">
          Mentions: <b style="color:var(--text)">${mentions.length}</b> •
          Friend requests: <b style="color:var(--text)">${friendReq.length}</b> •
          Group invites: <b style="color:var(--text)">${groupInv.length}</b> •
          Group requests: <b style="color:var(--text)">${groupReq.length}</b>
        </div>
        <button class="btn small primary" id="clearMentions">Clear mentions</button>
      </div>

      ${inboxItems.length ? inboxItems.map((it)=>{
        const ts = it.ts ? new Date(it.ts).toLocaleString() : "";
        let actions = "";

        if (it.type === "friend") {
          actions = `
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn small primary" data-acc="${esc(it.from)}">Accept</button>
              <button class="btn small" data-dec="${esc(it.from)}">Decline</button>
            </div>
          `;
        } else if (it.type === "group") {
          actions = `
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn small primary" data-gacc="${esc(it.id)}">Accept</button>
              <button class="btn small" data-gdec="${esc(it.id)}">Decline</button>
            </div>
          `;
        } else if (it.type === "groupReq") {
          actions = `
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <button class="btn small primary" data-gr-acc="${esc(it.meta?.groupId||"")}" data-gr-from="${esc(it.from||"")}">Approve</button>
              <button class="btn small" data-gr-dec="${esc(it.meta?.groupId||"")}" data-gr-from="${esc(it.from||"")}">Decline</button>
            </div>
          `;
        } else {
          actions = `<button class="btn small primary" data-openGlobal="1">Open</button>`;
        }

        return `
          <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px;display:flex;justify-content:space-between;gap:12px;align-items:center">
            <div style="min-width:0">
              <div style="font-weight:950">${esc(it.text || "")}</div>
              <div class="muted tiny" style="margin-top:4px">${esc(ts)}</div>
            </div>
            ${actions}
          </div>
        `;
      }).join("") : `<div class="muted">Nothing here right now.</div>`}
    </div>
  `);

  $("clearMentions").onclick = ()=> socket.emit("inbox:clearMentions");

  modalBody.querySelectorAll("[data-acc]").forEach(b=>{
    b.onclick = ()=> socket.emit("friend:accept", { from: b.getAttribute("data-acc") });
  });
  modalBody.querySelectorAll("[data-dec]").forEach(b=>{
    b.onclick = ()=> socket.emit("friend:decline", { from: b.getAttribute("data-dec") });
  });
  modalBody.querySelectorAll("[data-gacc]").forEach(b=>{
    b.onclick = ()=> socket.emit("groupInvite:accept", { id: b.getAttribute("data-gacc") });
  });
  modalBody.querySelectorAll("[data-gdec]").forEach(b=>{
    b.onclick = ()=> socket.emit("groupInvite:decline", { id: b.getAttribute("data-gdec") });
  });
  modalBody.querySelectorAll("[data-gr-acc]").forEach(b=>{
    b.onclick = ()=> socket.emit("groupJoin:approve", {
      groupId: b.getAttribute("data-gr-acc"),
      from: b.getAttribute("data-gr-from")
    });
  });
  modalBody.querySelectorAll("[data-gr-dec]").forEach(b=>{
    b.onclick = ()=> socket.emit("groupJoin:decline", {
      groupId: b.getAttribute("data-gr-dec"),
      from: b.getAttribute("data-gr-from")
    });
  });
  modalBody.querySelectorAll("[data-openGlobal]").forEach(b=>{
    b.onclick = ()=>{ closeModal(); openGlobal(); };
  });
}

// ---------- settings ----------
function openSettings(){
  const draft = {
    sounds: settings.sounds !== false,
    hideMildProfanity: !!settings.hideMildProfanity,
    allowFriendRequests: settings.allowFriendRequests !== false,
    allowGroupInvites: settings.allowGroupInvites !== false,
    customCursor: settings.customCursor !== false
  };

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <div style="font-weight:950">Sounds</div>
          <div class="muted tiny">Pings for mentions / DMs / group</div>
        </div>
        <button class="btn small" id="togSounds">${draft.sounds ? "On" : "Off"}</button>
      </div>

      <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <div style="font-weight:950">Hide mild profanity</div>
          <div class="muted tiny">Mask common swears</div>
        </div>
        <button class="btn small" id="togFilter">${draft.hideMildProfanity ? "On" : "Off"}</button>
      </div>

      <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <div style="font-weight:950">Friend requests</div>
          <div class="muted tiny">Allow others to send requests</div>
        </div>
        <button class="btn small" id="togFR">${draft.allowFriendRequests ? "On" : "Off"}</button>
      </div>

      <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <div style="font-weight:950">Group invites / requests</div>
          <div class="muted tiny">Allow group invites and join requests</div>
        </div>
        <button class="btn small" id="togGR">${draft.allowGroupInvites ? "On" : "Off"}</button>
      </div>

      <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div>
          <div style="font-weight:950">Custom cursor</div>
          <div class="muted tiny">Disable to use normal cursor</div>
        </div>
        <button class="btn small" id="togCursor">${draft.customCursor ? "On" : "Off"}</button>
      </div>

      <div class="muted tiny" style="line-height:1.45">
        Note: Do Not Disturb disables notifications even if sounds are on.
      </div>

      <div style="display:flex;justify-content:flex-end;gap:10px">
        <button class="btn primary" id="saveSettings">Save</button>
      </div>
    </div>
  `);

  $("togSounds").onclick = ()=>{
    draft.sounds = !draft.sounds;
    $("togSounds").textContent = draft.sounds ? "On" : "Off";
  };
  $("togFilter").onclick = ()=>{
    draft.hideMildProfanity = !draft.hideMildProfanity;
    $("togFilter").textContent = draft.hideMildProfanity ? "On" : "Off";
  };
  $("togFR").onclick = ()=>{
    draft.allowFriendRequests = !draft.allowFriendRequests;
    $("togFR").textContent = draft.allowFriendRequests ? "On" : "Off";
  };
  $("togGR").onclick = ()=>{
    draft.allowGroupInvites = !draft.allowGroupInvites;
    $("togGR").textContent = draft.allowGroupInvites ? "On" : "Off";
  };
  $("togCursor").onclick = ()=>{
    draft.customCursor = !draft.customCursor;
    $("togCursor").textContent = draft.customCursor ? "On" : "Off";
  };

  $("saveSettings").onclick = ()=>{
    settings = { ...settings, ...draft };
    applyCursorSetting();

    if (!isGuest) socket.emit("settings:update", settings);
    else localStorage.setItem("tonkotsu_guest_settings", JSON.stringify(settings));

    closeModal();
  };
}

// ---------- leaderboard ----------
function openLeaderboard(){
  if (isGuest) return openModal("Leaderboard", `<div class="muted">Guests can’t view the leaderboard.</div>`);
  showLoading("Loading leaderboard…");
  socket.emit("leaderboard:get", { limit: 25 });
}

// ---------- profile ----------
function friendState(target){
  if (!social) return "none";
  if (social.blocked?.includes(target)) return "blocked";
  if (social.friends?.includes(target)) return "friends";
  if (social.outgoing?.includes(target)) return "outgoing";
  if (social.incoming?.includes(target)) return "incoming";
  return "none";
}

function openProfile(user){
  if (!user) return;
  const isSelf = (user === me);

  // guests cannot be friended
  if (/^Guest\d{4,5}$/.test(user) && user !== me){
    openModal("Profile", `
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;font-size:15px;color:${userColor(user)}">${esc(user)}</div>
        <div class="muted tiny" style="margin-top:6px">Guest profile</div>
      </div>
      <div class="muted">Guests can’t be friended or DMed.</div>
    `);
    return;
  }

  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;font-size:15px;color:${userColor(user)}">${esc(user)}</div>
        <div class="muted tiny" id="profSub" style="margin-top:6px">loading…</div>
      </div>

      <div id="profStatsBox" style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;margin-bottom:8px">Stats</div>
        <div class="muted tiny" id="profStats">loading…</div>
      </div>

      ${(!isGuest && isSelf) ? `
        <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
          <div style="font-weight:950;margin-bottom:8px">Status</div>
          <select class="field" id="statusSelect" style="height:34px">
            <option value="online">Online</option>
            <option value="idle">Idle</option>
            <option value="dnd">Do Not Disturb</option>
            <option value="invisible">Offline</option>
          </select>
          <div class="muted tiny" style="margin-top:8px;line-height:1.45">
            Idle automatically turns on after 3 minutes of inactivity when you are Online.
          </div>
        </div>
      ` : ``}

      ${(!isGuest && !isSelf && user) ? `
        <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap">
          <button class="btn" id="btnDM">DM</button>
          <button class="btn primary" id="btnFriend">Add friend</button>
          <button class="btn" id="btnBlock">Block</button>
        </div>
      ` : ``}
    </div>
  `);

  // bind status if self
  const sel = $("statusSelect");
  if (sel) {
    sel.value = myStatus || "online";
    sel.onchange = ()=>{
      manualStatus = true;
      socket.emit("status:set", { status: sel.value });
    };
  }

  // action buttons
  const dm = $("btnDM");
  if (dm) dm.onclick = ()=>{ closeModal(); openDM(user); };

  const friendBtn = $("btnFriend");
  if (friendBtn) {
    const st = friendState(user);
    if (st === "friends") { friendBtn.textContent = "Friends"; friendBtn.disabled = true; }
    else if (st === "outgoing") { friendBtn.textContent = "Request sent"; friendBtn.disabled = true; }
    else if (st === "incoming") { friendBtn.textContent = "Accept request"; friendBtn.onclick = ()=> socket.emit("friend:accept", { from: user }); }
    else if (st === "blocked") { friendBtn.textContent = "Unblock"; friendBtn.onclick = ()=> socket.emit("user:unblock", { user }); }
    else { friendBtn.onclick = ()=> socket.emit("friend:request", { to: user }); }
  }

  const blockBtn = $("btnBlock");
  if (blockBtn) {
    const st = friendState(user);
    if (st === "blocked") { blockBtn.textContent = "Unblock"; blockBtn.onclick = ()=> socket.emit("user:unblock", { user }); }
    else { blockBtn.onclick = ()=> socket.emit("user:block", { user }); }
  }

  modalBody._profileUser = user;
  socket.emit("profile:get", { user });
}

// ---------- group info ----------
function openGroupInfo(groupId){
  const meta = groupMeta.get(groupId);
  if (!meta) return openModal("Group info", `<div class="muted">No group info.</div>`);

  const members = meta.members || [];
  const owner = meta.owner || "—";
  const privacy = meta.privacy || "private";
  const cooldown = Number(meta.cooldownSec || 2.5).toFixed(1);

  const isOwner = (!isGuest && owner === me);

  openModal("Group info", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;font-size:14px"># ${esc(meta.name)}</div>
        <div class="muted tiny" style="margin-top:6px">Owner: <b style="color:var(--text)">${esc(owner)}</b></div>
        <div class="muted tiny">Privacy: <b style="color:var(--text)">${esc(privacy)}</b></div>
        <div class="muted tiny">Members: <b style="color:var(--text)">${members.length}</b> / 200</div>
        <div class="muted tiny">Cooldown: <b style="color:var(--text)">${esc(cooldown)}s</b></div>
        <div class="muted tiny">ID: ${esc(meta.id)}</div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;margin-bottom:8px">Members</div>
        <div class="scroll" style="max-height:240px">
          ${members.map(u=>`
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:6px 0">
              <div class="tiny" style="color:${userColor(u)};font-weight:950">${esc(u)}${u===owner ? " (owner)" : ""}</div>
              ${isOwner && u!==owner ? `
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn small" data-mute="${esc(u)}">Mute</button>
                  <button class="btn small" data-unmute="${esc(u)}">Unmute</button>
                </div>
              ` : ``}
            </div>
          `).join("")}
        </div>
      </div>

      ${isOwner ? `
        <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px;display:flex;flex-direction:column;gap:10px">
          <div style="font-weight:950">Owner tools</div>

          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between">
            <div class="muted tiny">Mute all</div>
            <button class="btn small" id="togMuteAll">${meta.mutedAll ? "On" : "Off"}</button>
          </div>

          <div class="muted tiny">Group cooldown (seconds, 1.0–10.0)</div>
          <input class="field" id="gcCooldown" placeholder="2.5" value="${esc(String(Number(meta.cooldownSec || 2.5).toFixed(1)))}" />

          <div class="muted tiny">Invite friend (must be your friend)</div>
          <input class="field" id="addMemberName" placeholder="username" />

          <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap">
            <button class="btn" id="saveGroupSettings">Save</button>
            <button class="btn primary" id="inviteMemberBtn">Invite</button>
            <button class="btn" id="deleteGroupBtn" style="border-color:rgba(255,77,77,.25)">Delete group</button>
          </div>
        </div>
      ` : `
        <div style="display:flex;justify-content:flex-end">
          <button class="btn" id="leaveGroupBtn" style="border-color:rgba(255,77,77,.25)">Leave group</button>
        </div>
      `}
    </div>
  `);

  $("leaveGroupBtn")?.addEventListener("click", ()=>{ socket.emit("group:leave", { groupId }); closeModal(); });

  $("deleteGroupBtn")?.addEventListener("click", ()=>{
    openModal("Delete group", `
      <div class="muted" style="line-height:1.45">Delete this group for everyone?</div>
      <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:12px">
        <button class="btn" id="cancelDel">Cancel</button>
        <button class="btn primary" id="confirmDel" style="border-color:rgba(255,77,77,.30)">Delete</button>
      </div>
    `);
    $("cancelDel").onclick = ()=>{ closeModal(); openGroupInfo(groupId); };
    $("confirmDel").onclick = ()=>{ socket.emit("group:delete", { groupId }); closeModal(); };
  });

  // owner tools
  $("togMuteAll")?.addEventListener("click", ()=>{
    socket.emit("group:muteAll", { groupId, on: !meta.mutedAll });
  });

  $("saveGroupSettings")?.addEventListener("click", ()=>{
    const v = Number(($("gcCooldown")?.value || "").trim());
    if (!Number.isFinite(v)) return;
    socket.emit("group:settings", { groupId, cooldownSec: clamp(v, 1, 10) });
  });

  $("inviteMemberBtn")?.addEventListener("click", ()=>{
    const name = ($("addMemberName")?.value || "").trim();
    if (!isValidUser(name)) return;
    socket.emit("group:invite", { groupId, user: name });
    $("addMemberName").value = "";
  });

  // mute/unmute buttons
  modalBody.querySelectorAll("[data-mute]").forEach(b=>{
    b.onclick = ()=> socket.emit("group:muteUser", { groupId, user: b.getAttribute("data-mute"), on: true });
  });
  modalBody.querySelectorAll("[data-unmute]").forEach(b=>{
    b.onclick = ()=> socket.emit("group:muteUser", { groupId, user: b.getAttribute("data-unmute"), on: false });
  });
}

// ---------- create group ----------
createGroupBtn.addEventListener("click", ()=>{
  if (isGuest) return openModal("Groups", `<div class="muted">Guests can’t create groups.</div>`);

  openModal("Create group", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="muted tiny">Name</div>
      <input class="field" id="gcName" placeholder="group" />

      <div style="display:flex;gap:10px;align-items:center;justify-content:space-between">
        <div>
          <div style="font-weight:950">Public group</div>
          <div class="muted tiny">Public groups show in Discover</div>
        </div>
        <button class="btn small" id="gcPublic">Off</button>
      </div>

      <div class="muted tiny">Invite friends (comma separated, optional)</div>
      <input class="field" id="gcInv" placeholder="friend1, friend2" />

      <div class="muted tiny" style="line-height:1.45">
        Group hard cap is 200 members. Invites are limited to your friends.
      </div>

      <div style="display:flex;justify-content:flex-end">
        <button class="btn primary" id="gcCreate">Create</button>
      </div>
    </div>
  `);

  let isPublic = false;
  $("gcPublic").onclick = ()=>{
    isPublic = !isPublic;
    $("gcPublic").textContent = isPublic ? "On" : "Off";
  };

  $("gcCreate").onclick = ()=>{
    const name = ($("gcName")?.value || "").trim();
    const invitesRaw = ($("gcInv")?.value || "").trim();
    const invites = invitesRaw ? invitesRaw.split(",").map(s=>s.trim()).filter(Boolean) : [];
    const unique = Array.from(new Set(invites)).slice(0, 50);

    for (const u of unique) if (!isValidUser(u)) return openModal("Create group", `<div class="muted">Invites must be usernames (letters/numbers only, 4–20).</div>`);

    closeModal();
    socket.emit("group:createRequest", { name, invites: unique, privacy: isPublic ? "public" : "private" });
  };
});

// ---------- discover groups ----------
discoverGroupsBtn?.addEventListener("click", ()=>{
  if (isGuest) return openModal("Discover", `<div class="muted">Guests can’t discover/join groups.</div>`);
  showLoading("Discovering groups…");
  socket.emit("groups:discover");
});

// ---------- login ----------
togglePass?.addEventListener("click", ()=>{
  if (!passwordEl) return;
  passwordEl.type = (passwordEl.type === "password") ? "text" : "password";
});

function explainLoginFail(u, p){
  if (!u || u.length < 4) return "Username must be at least 4 characters.";
  if (!/^[A-Za-z0-9]+$/.test(u)) return "Username can only use letters and numbers (no symbols).";
  if (u.length > 20) return "Username max is 20 characters.";
  if (!p || p.length < 4) return "Password must be at least 4 characters.";
  if (!/^[A-Za-z0-9]+$/.test(p)) return "Password can only use letters and numbers (no symbols).";
  if (p.length > 32) return "Password max is 32 characters.";
  return "Login details are invalid.";
}

joinBtn?.addEventListener("click", ()=>{
  const u = (usernameEl.value || "").trim();
  const p = (passwordEl.value || "").trim();
  if (!isValidUser(u) || !isValidPass(p)) {
    return openModal("Login", `<div class="muted">${esc(explainLoginFail(u,p))}</div>`);
  }
  showLoading("Logging in…");
  socket.emit("login", { username: u, password: p, guest: false });
});

guestBtn?.addEventListener("click", ()=>{
  showLoading("Joining as guest…");
  socket.emit("login", { guest: true });
});

passwordEl?.addEventListener("keydown",(e)=>{
  if (e.key === "Enter") joinBtn.click();
});

// ---------- session resume ----------
function tryResume(){
  if (!token) return;
  showLoading("Resuming session…");
  socket.emit("resume", { token });
}

// ---------- socket events ----------
socket.on("resumeFail", ()=>{
  hideLoading();
});

socket.on("loginError", (msg)=>{
  hideLoading();
  openModal("Login failed", `<div class="muted">${esc(msg || "Try again.")}</div>`);
});

socket.on("loginSuccess", (data)=>{
  showLoading("Entering…");

  me = data.username;
  isGuest = !!data.guest;

  settings = { ...settings, ...(data.settings || {}) };
  social = data.social || social;
  myStatus = data.status || "online";

  // guest settings override (client-only)
  if (isGuest) {
    try{
      const gs = JSON.parse(localStorage.getItem("tonkotsu_guest_settings") || "null");
      if (gs && typeof gs === "object") settings = { ...settings, ...gs };
    }catch{}
  }

  if (!isGuest && data.token) {
    token = data.token;
    localStorage.setItem("tonkotsu_token", token);
  }

  meName.textContent = me;
  mePill.style.display = "flex";

  // inbox icon only for logged-in accounts
  if (!isGuest) inboxBtnWrap.style.display = "block";
  else inboxBtnWrap.style.display = "none";

  applyCursorSetting();
  updateHints();

  setTimeout(()=>{
    loginOverlay.classList.add("hidden");
    hideLoading();

    setView("global");
    socket.emit("requestGlobalHistory");

    if (!isGuest) {
      socket.emit("social:sync");
      socket.emit("groups:list");
      socket.emit("inbox:get");
      socket.emit("cooldown:get");
    } else {
      // guests still get cooldown info
      socket.emit("cooldown:get");
    }

    renderChannels();
    idleLoop();
  }, 280);
});

socket.on("settings", (s)=>{
  if (s) {
    settings = { ...settings, ...s };
    applyCursorSetting();
  }
});

socket.on("status:update", ({ status }={})=>{
  if (!status) return;
  myStatus = status;
  updateHints();
});

socket.on("cooldown:update", ({ seconds }={})=>{
  if (Number.isFinite(Number(seconds))) {
    cooldownSec = clamp(Number(seconds), 0.8, 12);
    updateHints();
  }
});

socket.on("onlineUsers", (list)=>{
  onlineUsers = Array.isArray(list) ? list : [];
  renderOnline();

  const mine = onlineUsers.find(x=>x.user === me);
  if (mine?.status) {
    myStatus = mine.status;
    updateHints();
  }
});

socket.on("inbox:badge", (counts)=>{
  inboxCounts = counts || inboxCounts;
  const n = Number(inboxCounts.total || 0);
  if (inboxBadgeMini){
    inboxBadgeMini.textContent = String(n);
    inboxBadgeMini.classList.toggle("show", n > 0);
  }
  renderChannels(); // mentions badge on global
});

socket.on("inbox:data", ({ items }={})=>{
  inboxItems = Array.isArray(items) ? items : [];
});

socket.on("history", (msgs)=>{
  globalCache = Array.isArray(msgs) ? msgs : [];
  if (view.type === "global"){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, "global"));
  }
});

socket.on("globalMessage", (msg)=>{
  if (!msg) return;
  globalCache.push(msg);
  if (globalCache.length > 350) globalCache.shift();

  if (view.type === "global") addMessageToUI(msg, "global");

  if (me && typeof msg.text === "string") {
    const hit = msg.text.toLowerCase().includes(`@${me.toLowerCase()}`);
    if (hit && canNotify()) pingSound("mention");
  }
});

socket.on("dm:history", ({ withUser, msgs }={})=>{
  const other = withUser;
  dmCache.set(other, Array.isArray(msgs) ? msgs : []);
  if (view.type === "dm" && view.id === other){
    clearChat();
    dmCache.get(other).forEach(m=> addMessageToUI(m, "dm"));
  }
  renderChannels();
});

socket.on("dm:message", ({ from, msg }={})=>{
  if (!from || !msg) return;
  if (!dmCache.has(from)) dmCache.set(from, []);
  dmCache.get(from).push(msg);
  if (dmCache.get(from).length > 260) dmCache.get(from).shift();

  const inDM = (view.type === "dm" && view.id === from);
  if (inDM) addMessageToUI(msg, "dm");
  else if (canNotify()) pingSound("dm");

  renderChannels();
});

socket.on("groups:list", (list)=>{
  groupMeta.clear();
  (Array.isArray(list) ? list : []).forEach(g=>{
    groupMeta.set(g.id, {
      id:g.id,
      name:g.name,
      owner:g.owner,
      members:g.members || [],
      privacy: g.privacy || "private",
      cooldownSec: g.cooldownSec ?? 2.5,
      mutedAll: !!g.mutedAll
    });
  });
  renderChannels();
});

socket.on("groups:discover:data", ({ items }={})=>{
  hideLoading();
  const list = Array.isArray(items) ? items : [];
  openModal("Discover groups", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="muted tiny">Public groups you can join</div>
      ${list.length ? list.map(g=>{
        const inIt = groupMeta.has(g.id);
        return `
          <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px;display:flex;justify-content:space-between;gap:12px;align-items:center">
            <div style="min-width:0">
              <div style="font-weight:950"># ${esc(g.name)}</div>
              <div class="muted tiny" style="margin-top:4px">${esc(g.members)} members • owner: ${esc(g.owner)}</div>
            </div>
            ${inIt ? `<button class="btn small" disabled>Joined</button>` : `<button class="btn small primary" data-join="${esc(g.id)}">Join</button>`}
          </div>
        `;
      }).join("") : `<div class="muted">No public groups found.</div>`}
    </div>
  `);

  modalBody.querySelectorAll("[data-join]").forEach(b=>{
    b.onclick = ()=>{
      const gid = b.getAttribute("data-join");
      socket.emit("group:joinPublic", { groupId: gid });
      b.textContent = "Joining…";
      b.disabled = true;
    };
  });
});

socket.on("group:history", ({ groupId, meta, msgs }={})=>{
  if (!groupId) return;
  if (meta) groupMeta.set(groupId, meta);
  groupCache.set(groupId, Array.isArray(msgs) ? msgs : []);

  setView("group", groupId);
  clearChat();
  groupCache.get(groupId).forEach(m=> addMessageToUI(m, "group"));
  renderChannels();
});

socket.on("group:message", ({ groupId, msg }={})=>{
  if (!groupId || !msg) return;
  if (!groupCache.has(groupId)) groupCache.set(groupId, []);
  groupCache.get(groupId).push(msg);
  if (groupCache.get(groupId).length > 420) groupCache.get(groupId).shift();

  const inGroup = (view.type === "group" && view.id === groupId);
  if (inGroup) addMessageToUI(msg, "group");
  else if (canNotify()) pingSound("default");

  renderChannels();
});

socket.on("group:meta", ({ groupId, meta }={})=>{
  if (!groupId || !meta) return;
  groupMeta.set(groupId, meta);
  if (view.type === "group" && view.id === groupId) {
    topicTitle.textContent = `# ${meta.name}`;
    topicSub.textContent = `${meta.privacy || "private"} • group chat`;
    topicTitle.classList.add("clickable");
    topicTitle.onclick = ()=> openGroupInfo(groupId);
  }
  renderChannels();
});

socket.on("group:left", ({ groupId }={})=>{
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  openGlobal();
  socket.emit("groups:list");
});

socket.on("group:deleted", ({ groupId }={})=>{
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  openGlobal();
  socket.emit("groups:list");
});

// profile data
socket.on("profile:data", (p)=>{
  const target = modalBody?._profileUser;
  if (!target || !p || p.user !== target) return;

  const sub = $("profSub");
  const stats = $("profStats");
  const statsBox = $("profStatsBox");

  if (!p.exists || p.guest) {
    if (sub) sub.textContent = "Guest or unknown user";
    if (statsBox) statsBox.style.display = "none";
    return;
  }

  const created = p.createdAt ? new Date(p.createdAt).toLocaleString() : "—";
  const lvl = Number(p.level || 1);
  const xp = Number(p.xp || 0);
  const next = Number(p.next || 100);
  const msgs = Number(p.messages || 0);
  const st = p.status || "online";
  const pct = next > 0 ? clamp(xp/next, 0, 1) : 0;

  if (sub) sub.textContent = `Status: ${statusLabel(st)} • Level ${lvl}`;

  if (stats) {
    stats.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px"><div>Created</div><div>${esc(created)}</div></div>
      <div style="display:flex;justify-content:space-between;gap:10px"><div>Messages</div><div>${esc(msgs)}</div></div>
      <div style="display:flex;justify-content:space-between;gap:10px"><div>XP</div><div>${esc(xp)}/${esc(next)}</div></div>
      <div style="margin-top:10px" class="bar"><div class="barFill" id="xpFill"></div></div>
    `;
    const fill = $("xpFill");
    if (fill) setTimeout(()=>{ fill.style.width = `${Math.round(pct*100)}%`; }, 50);
  }

  const sel = $("statusSelect");
  if (sel && target === me) sel.value = (st === "invisible") ? "invisible" : st;
});

// leaderboard data
socket.on("leaderboard:data", ({ items }={})=>{
  hideLoading();
  const list = Array.isArray(items) ? items : [];
  openModal("Leaderboard", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="muted tiny">Top users by level, then XP</div>
      ${list.map((u, i)=>{
        const pct = u.next > 0 ? clamp(u.xp/u.next, 0, 1) : 0;
        return `
          <div style="border:1px solid rgba(255,255,255,.08);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
            <div style="display:flex;justify-content:space-between;gap:10px;align-items:center">
              <div style="display:flex;gap:10px;align-items:center;min-width:0">
                <div style="width:26px;text-align:center;font-weight:950;opacity:.85">#${i+1}</div>
                <div style="min-width:0">
                  <div style="font-weight:950;color:${userColor(u.user)};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(u.user)}</div>
                  <div class="muted tiny">Messages: ${esc(u.messages)}</div>
                </div>
              </div>
              <div style="text-align:right">
                <div style="font-weight:950">Lv ${esc(u.level)}</div>
                <div class="muted tiny">${esc(u.xp)}/${esc(u.next)} XP</div>
              </div>
            </div>
            <div class="bar" style="margin-top:10px"><div class="barFill" style="width:${Math.round(pct*100)}%"></div></div>
          </div>
        `;
      }).join("")}
    </div>
  `);
});

socket.on("social:update", (s)=>{ if (s) social = s; });

socket.on("sendError", ({ reason }={})=>{
  if (reason) openModal("Error", `<div class="muted">${esc(reason)}</div>`);
});

// ---------- boot ----------
setView("global");
renderChannels();
renderOnline();
applyCursorSetting();
updateHints();
tryResume();
