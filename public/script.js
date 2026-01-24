/* public/script.js
   Full client for tonkotsu.online

   Implements:
   - No simulated bots
   - Sidebar online list capped/collapsible so messages panel is visible
   - Friend request from profile -> appears in target inbox
   - Mentions: badge count appears on Inbox + Global chat entry
   - Discord-ish red curved-square badges
   - Removes unnecessary dots (no green dot for Global/Inbox entries)
   - More transitions: loading overlay + chat fade on view switch + login transition
   - Status colors + status change ONLY in your profile
   - DND mutes notifications; Idle auto after 3 minutes inactivity
*/

const socket = io();
const $ = (id) => document.getElementById(id);

// -------------------- DOM --------------------
const loginOverlay = $("loginOverlay");
const loginCard = $("loginCard");
const loading = $("loading");
const loaderSub = $("loaderSub");

const usernameEl = $("username");
const passwordEl = $("password");
const joinBtn = $("joinBtn");
const guestBtn = $("guestBtn");
const togglePass = $("togglePass");

const chatTitle = $("chatTitle");
const chatHint = $("chatHint");
const chatBox = $("chatBox");
const messageEl = $("message");
const sendBtn = $("sendBtn");

const cooldownRow = $("cooldownRow");
const cooldownText = $("cooldownText");
const cdFill = $("cdFill");
const cooldownLabel = $("cooldownLabel");
const statusLabel = $("statusLabel");

const mePill = $("mePill");
const meName = $("meName");
const meSub = $("meSub");
const meStatusDot = $("meStatusDot");

const inboxBtn = $("inboxBtn");
const inboxPing = $("inboxPing");
const msgPing = $("msgPing");

const onlineCount = $("onlineCount");
const onlineList = $("onlineList");
const onlineWrap = $("onlineWrap");
const onlineToggle = $("onlineToggle");

const msgList = $("msgList");
const createGroupBtn = $("createGroupBtn");

const modalBack = $("modalBack");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
const modalClose = $("modalClose");

const toasts = $("toasts");
const yearEl = $("year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

const cursorDot = $("cursorDot");
const cursorRing = $("cursorRing");

// -------------------- State --------------------
let me = null;
let isGuest = false;
let token = localStorage.getItem("tonkotsu_token") || null;

let settings = null;
let social = null;

let myStatus = "online";
let manualStatus = false;
let autoIdleEngaged = false;

let view = { type: "global", id: null }; // global|dm|group
let currentDM = null;
let currentGroupId = null;

let onlineUsers = []; // [{user,status,guest}]
let globalCache = [];
let dmCache = new Map();     // user -> msgs
let groupMeta = new Map();   // gid -> meta
let groupCache = new Map();  // gid -> msgs

let unreadDM = new Map();
let unreadGroup = new Map();

// Inbox-related caches
let groupInvitesCache = [];
let friendRequestsCache = [];
let inboxMentionsCache = []; // stored mention items
let inboxCounts = { total:0, friend:0, groupInv:0, ment:0 }; // from server badge
let unreadGlobalMentions = 0; // show on Global entry

// Cooldown
let cooldownUntil = 0;

// Cursor
let cursorMode = "trail";
let reduceAnims = false;

// -------------------- Helpers --------------------
function now(){ return Date.now(); }
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"quot;")
    .replaceAll("'","&#039;");
}

function showLoading(text="syncing…"){
  if (loaderSub) loaderSub.textContent = text;
  if (loading) loading.classList.add("show");
}
function hideLoading(){
  if (loading) loading.classList.remove("show");
}

function fadeChatOnce(){
  if (!chatBox) return;
  chatBox.classList.add("fading");
  const ms = reduceAnims ? 60 : 140;
  setTimeout(()=> chatBox.classList.remove("fading"), ms);
}

function canNotify(){
  if (myStatus === "dnd") return false;
  if (myStatus === "invisible") return false;
  return true;
}

function toast(title, msg){
  if (!toasts) return;
  if (!canNotify()) return;

  const d = document.createElement("div");
  d.className = "toast";
  d.innerHTML = `
    <div class="toastDot"></div>
    <div>
      <div class="toastTitle">${escapeHtml(title)}</div>
      <div class="toastMsg">${escapeHtml(msg)}</div>
    </div>
  `;
  toasts.appendChild(d);
  const dur = reduceAnims ? 1600 : 2600;
  setTimeout(()=>{ d.style.opacity="0"; d.style.transform="translateY(10px)"; }, dur);
  setTimeout(()=> d.remove(), dur + 350);
}

function openModal(title, html){
  if (!modalBack || !modalTitle || !modalBody) return;
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalBack.classList.add("show");
}
function closeModal(){
  if (!modalBack) return;
  modalBack.classList.remove("show");
  if (modalBody) modalBody.innerHTML = "";
}
if (modalClose) modalClose.addEventListener("click", closeModal);
if (modalBack) modalBack.addEventListener("click",(e)=>{ if(e.target===modalBack) closeModal(); });

function fmtTime(ts){
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
}

// Strict credentials: letters+numbers only, min 4
function credValid(s){
  const t = String(s || "").trim();
  return /^[A-Za-z0-9]{4,20}$/.test(t);
}
function passValid(s){
  const t = String(s || "").trim();
  return /^[A-Za-z0-9]{4,32}$/.test(t);
}

// Mild profanity masking
const MILD_WORDS = ["fuck","fucking","shit","shitty","asshole","bitch","bastard","dick","pussy"];
const MILD_RX = new RegExp(`\\b(${MILD_WORDS.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})\\b`, "ig");
function maybeHideMild(text){
  if (!settings?.hideMildProfanity) return text;
  return String(text).replace(MILD_RX, "•••");
}

function isBlockedUser(u){
  return !!social?.blocked?.includes(u);
}

// -------------------- Sound --------------------
function pingSound(){
  if (!settings?.sounds) return;
  if (!canNotify()) return;
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 740;
    g.gain.value = 0.045;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(()=>{ o.stop(); ctx.close(); }, 90);
  }catch{}
}

// -------------------- Cursor --------------------
let mouseX = window.innerWidth/2, mouseY = window.innerHeight/2;
let dotX = mouseX, dotY = mouseY, ringX = mouseX, ringY = mouseY;
const trail = [];
const TRAIL_MAX = 10;

function setCursorMode(mode){
  cursorMode = mode; // off|dot|trail
  const off = (mode === "off");
  document.body.style.cursor = off ? "auto" : "none";

  const styleElId = "__cursor_force__";
  let styleEl = document.getElementById(styleElId);
  if (!styleEl){
    styleEl = document.createElement("style");
    styleEl.id = styleElId;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = off
    ? `a,button,input,textarea,.row,.btn,.pill{cursor:auto!important}`
    : `a,button,input,textarea,.row,.btn,.pill{cursor:none!important}`;

  if (cursorDot) cursorDot.style.display = off ? "none" : "block";
  if (cursorRing) cursorRing.style.display = off ? "none" : "block";
  document.querySelectorAll(".cursorTrail").forEach(n=>n.remove());
  trail.length = 0;
}

window.addEventListener("mousemove",(e)=>{
  mouseX = e.clientX;
  mouseY = e.clientY;
  if (cursorMode === "trail" && !reduceAnims){
    trail.unshift({x:mouseX, y:mouseY, t: now()});
    if (trail.length > TRAIL_MAX) trail.pop();
  }
});

function cursorTick(){
  const dotLerp = reduceAnims ? 1 : 0.35;
  const ringLerp = reduceAnims ? 1 : 0.18;

  dotX += (mouseX - dotX) * dotLerp;
  dotY += (mouseY - dotY) * dotLerp;
  ringX += (mouseX - ringX) * ringLerp;
  ringY += (mouseY - ringY) * ringLerp;

  if (cursorDot) cursorDot.style.transform = `translate(${dotX}px, ${dotY}px) translate(-50%,-50%)`;
  if (cursorRing) cursorRing.style.transform = `translate(${ringX}px, ${ringY}px) translate(-50%,-50%)`;

  if (cursorMode === "trail" && !reduceAnims){
    document.querySelectorAll(".cursorTrail").forEach(n=>n.remove());
    const nowT = now();
    trail.forEach((p,i)=>{
      const age = nowT - p.t;
      const op = clamp(1 - age / 250, 0, 1) * (1 - i/(TRAIL_MAX+2));
      if (op <= 0.02) return;
      const n = document.createElement("div");
      n.className = "cursorTrail";
      n.style.opacity = String(op);
      n.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%,-50%)`;
      n.style.width = (10 - i*0.5) + "px";
      n.style.height = (10 - i*0.5) + "px";
      document.body.appendChild(n);
    });
  }

  requestAnimationFrame(cursorTick);
}

// -------------------- Cooldown --------------------
function cooldownSeconds(){ return isGuest ? 5 : 3; }
function canSend(){ return now() >= cooldownUntil; }

function startCooldown(){
  const secs = cooldownSeconds();
  cooldownUntil = now() + secs * 1000;
  if (cooldownLabel) cooldownLabel.textContent = `Cooldown: ${secs}s`;
  if (cooldownRow) cooldownRow.style.display = "flex";
  updateCooldown();
}
function updateCooldown(){
  const msLeft = cooldownUntil - now();
  const total = cooldownSeconds() * 1000;
  const p = clamp(1 - msLeft / total, 0, 1);
  if (cdFill) cdFill.style.width = (p * 100) + "%";

  if (msLeft <= 0){
    if (cooldownRow){
      cooldownRow.style.display = "none";
      cooldownRow.classList.remove("warn","shake");
    }
    return;
  }
  if (cooldownText) cooldownText.textContent = (msLeft/1000).toFixed(1)+"s";
  requestAnimationFrame(updateCooldown);
}
function cooldownWarn(){
  if (!cooldownRow) return;
  cooldownRow.style.display = "flex";
  cooldownRow.classList.add("warn","shake");
  setTimeout(()=> cooldownRow.classList.remove("shake"), 350);
  setTimeout(()=> cooldownRow.classList.remove("warn"), 900);
}

// -------------------- Status UI helpers --------------------
function dotClassForStatus(st){
  if (st === "online") return "online";
  if (st === "idle") return "idle";
  if (st === "dnd") return "dnd";
  return "offline";
}
function labelForStatus(st){
  if (st === "online") return "Online";
  if (st === "idle") return "Idle";
  if (st === "dnd") return "Do Not Disturb";
  return "Offline";
}
function applyMyStatusUI(){
  if (statusLabel) statusLabel.textContent = `Status: ${labelForStatus(myStatus)}`;
  if (meStatusDot){
    meStatusDot.className = `statusDot ${dotClassForStatus(myStatus)}`;
  }
}

// -------------------- Auto Idle (3 minutes) --------------------
let lastActivity = now();
function markActivity(){
  lastActivity = now();
  if (!isGuest && me && autoIdleEngaged && myStatus === "idle"){
    autoIdleEngaged = false;
    if (!manualStatus){
      socket.emit("status:set", { status: "online" });
    }
  }
}
["mousemove","keydown","mousedown","touchstart","scroll"].forEach(evt=>{
  window.addEventListener(evt, markActivity, { passive:true });
});
function idleTick(){
  if (!isGuest && me){
    const inactiveMs = now() - lastActivity;
    if (!manualStatus && myStatus === "online" && inactiveMs >= 180000){
      autoIdleEngaged = true;
      socket.emit("status:set", { status: "idle" });
    }
  }
  setTimeout(idleTick, 1500);
}

// -------------------- View + Rendering --------------------
function setView(type, id=null){
  view = { type, id };
  currentDM = (type==="dm") ? id : null;
  currentGroupId = (type==="group") ? id : null;

  if (!chatTitle || !chatHint) return;

  chatTitle.classList.remove("clickable");
  chatTitle.onclick = null;

  if (type === "global"){
    chatTitle.textContent = "Global chat";
    chatHint.textContent = "shared with everyone";
  } else if (type === "dm"){
    chatTitle.textContent = `DM — ${id}`;
    chatHint.textContent = "private messages";
  } else if (type === "group"){
    const meta = groupMeta.get(id);
    chatTitle.textContent = meta ? `Group — ${meta.name}` : "Group chat";
    chatHint.textContent = "group messages";
    chatTitle.classList.add("clickable");
    chatTitle.onclick = ()=> openGroupInfo(id);
  }
}

function clearChat(){
  if (chatBox) chatBox.innerHTML = "";
}

function renderTextWithMentions(text){
  if (!me) return escapeHtml(text);
  const safe = escapeHtml(text);
  const rx = new RegExp(`(@${me.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`, "ig");
  return safe.replace(rx, `<span style="color:var(--danger);font-weight:950">$1</span>`);
}

function addMessageToUI({ user, text, ts }, scope){
  if (!chatBox) return;

  let who = user;
  let bodyText = String(text ?? "");
  if (bodyText === "__HIDDEN_BY_FILTER__") bodyText = "Message hidden (filtered).";

  if (scope === "global" && who && isBlockedUser(who)){
    bodyText = "Message hidden (blocked user).";
  } else {
    bodyText = maybeHideMild(bodyText);
  }

  const isBlocked = (scope === "global" && who && isBlockedUser(who));
  const time = fmtTime(ts);

  const row = document.createElement("div");
  row.className = "msg";

  const revealBtn = isBlocked
    ? `<div style="margin-top:8px"><button class="btn small" data-reveal="1">Unblur message</button></div>`
    : ``;

  const bodyHTML = isBlocked
    ? `<div class="body" style="filter:blur(7px);opacity:.55" data-body="1">${renderTextWithMentions("Hidden (blocked user).")}</div>${revealBtn}`
    : `<div class="body">${renderTextWithMentions(bodyText)}</div>`;

  row.innerHTML = `
    <div class="bubble">
      <div class="meta">
        <div class="u" data-user="${escapeHtml(who)}">${escapeHtml(who)}${(who===me?" (You)":"")}</div>
        <div class="t">${escapeHtml(time)}</div>
      </div>
      ${bodyHTML}
    </div>
  `;

  const uEl = row.querySelector(".u");
  if (uEl){
    uEl.addEventListener("click", ()=>{
      const u = uEl.getAttribute("data-user");
      openProfile(u);
    });
  }

  const reveal = row.querySelector('[data-reveal="1"]');
  if (reveal){
    reveal.addEventListener("click", ()=>{
      const b = row.querySelector('[data-body="1"]');
      if (b){
        b.style.filter = "none";
        b.style.opacity = "1";
        b.innerHTML = renderTextWithMentions(maybeHideMild(String(text ?? "")));
      }
      reveal.remove();
    });
  }

  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
}

// -------------------- Sidebar: Online + Messages --------------------
function renderOnline(){
  if (!onlineList) return;
  if (onlineCount) onlineCount.textContent = String(onlineUsers.length);

  onlineList.innerHTML = onlineUsers.map(u=>{
    const name = u.user;
    const st = u.status || "online";
    return `
      <div class="row" data-open-profile="${escapeHtml(name)}">
        <div class="rowLeft">
          <div class="statusDot ${escapeHtml(dotClassForStatus(st))}"></div>
          <div class="nameCol">
            <div class="rowName">${escapeHtml(name)}${name===me?" (You)":""}</div>
            <div class="rowSub">${escapeHtml(labelForStatus(st))}</div>
          </div>
        </div>
      </div>
    `;
  }).join("");

  onlineList.querySelectorAll("[data-open-profile]").forEach(el=>{
    el.addEventListener("click", ()=>{
      openProfile(el.getAttribute("data-open-profile"));
    });
  });
}

function totalMessagePings(){
  let n = 0;
  for (const v of unreadDM.values()) n += v;
  for (const v of unreadGroup.values()) n += v;
  return n;
}

function updateBadges(){
  // Messages badge = DMs + Groups + (optionally) global mentions
  const m = totalMessagePings() + (unreadGlobalMentions || 0);
  if (msgPing){
    msgPing.textContent = String(m);
    msgPing.classList.toggle("show", m > 0);
  }

  // Inbox badge = friend requests + group invites + mentions (server counts)
  const total = Number(inboxCounts?.total || 0);
  if (inboxPing){
    inboxPing.textContent = String(total);
    inboxPing.classList.toggle("show", total > 0);
  }
}

function renderMessagesList(){
  if (!msgList) return;

  const dmUsers = Array.from(dmCache.keys()).sort((a,b)=>a.localeCompare(b));
  const groups = Array.from(groupMeta.values()).sort((a,b)=>String(a.name).localeCompare(String(b.name)));

  msgList.innerHTML = `
    <!-- Global entry: NO green dot. Uses icon box + mention badge -->
    <div class="row" data-open="global">
      <div class="rowLeft">
        <div class="iconBox">GL</div>
        <div class="nameCol">
          <div class="rowName">Global chat</div>
          <div class="rowSub">shared</div>
        </div>
      </div>
      <div class="badge ${unreadGlobalMentions>0?"show":""}" id="globalMentionBadge">${unreadGlobalMentions || 0}</div>
    </div>

    ${dmUsers.map(u=>{
      const c = unreadDM.get(u) || 0;
      const onlineRec = onlineUsers.find(x=>x.user===u);
      const st = onlineRec?.status || "offline";
      return `
        <div class="row" data-open="dm" data-id="${escapeHtml(u)}">
          <div class="rowLeft">
            <div class="statusDot ${escapeHtml(dotClassForStatus(st))}"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u)}</div>
              <div class="rowSub">dm</div>
            </div>
          </div>
          <div class="badge ${c>0?"show":""}" style="display:${c>0?"flex":"none"}">${c}</div>
        </div>
      `;
    }).join("")}

    ${groups.map(g=>{
      const c = unreadGroup.get(g.id) || 0;
      const members = Array.isArray(g.members) ? g.members.length : 0;
      return `
        <div class="row" data-open="group" data-id="${escapeHtml(g.id)}">
          <div class="rowLeft">
            <div class="iconBox">GC</div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(g.name)}</div>
              <div class="rowSub">${members} members</div>
            </div>
          </div>
          <div class="badge ${c>0?"show":""}" style="display:${c>0?"flex":"none"}">${c}</div>
        </div>
      `;
    }).join("")}
  `;

  // Hide the global badge element cleanly if needed
  const gb = $("globalMentionBadge");
  if (gb){
    gb.textContent = String(unreadGlobalMentions || 0);
    gb.classList.toggle("show", (unreadGlobalMentions || 0) > 0);
  }

  msgList.querySelectorAll("[data-open]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const t = el.getAttribute("data-open");
      const id = el.getAttribute("data-id");
      if (t === "global") openGlobal();
      if (t === "dm") openDM(id);
      if (t === "group") openGroup(id);
    });
  });

  updateBadges();
}

// -------------------- Openers (with transitions) --------------------
function openGlobal(){
  showLoading("opening global…");
  fadeChatOnce();
  setTimeout(()=>{
    setView("global");
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, "global"));
    socket.emit("requestGlobalHistory");

    // Reset mention badge when you enter global
    unreadGlobalMentions = 0;
    updateBadges();
    renderMessagesList();

    hideLoading();
  }, reduceAnims ? 70 : 160);
}

function openDM(user){
  if (isGuest){
    toast("Guests", "Guests can’t use DMs. Log in to DM.");
    return;
  }
  if (!user) return;

  showLoading("opening dm…");
  fadeChatOnce();

  unreadDM.set(user, 0);
  updateBadges();

  setTimeout(()=>{
    setView("dm", user);
    clearChat();
    socket.emit("dm:history", { withUser: user });
    hideLoading();
  }, reduceAnims ? 70 : 160);
}

function openGroup(gid){
  if (isGuest) return;
  if (!gid) return;

  showLoading("opening group…");
  fadeChatOnce();

  unreadGroup.set(gid, 0);
  updateBadges();

  setTimeout(()=>{
    setView("group", gid);
    clearChat();
    socket.emit("group:history", { groupId: gid });
    hideLoading();
  }, reduceAnims ? 70 : 160);
}

// -------------------- Inbox --------------------
function openInbox(){
  if (isGuest){
    openModal("Inbox", `<div class="muted">Guest mode has no inbox.</div>`);
    return;
  }

  // Always refresh from server first
  socket.emit("inbox:get");

  const items = [];

  // Mentions
  for (const m of (inboxMentionsCache || [])){
    items.push({ kind:"mention", label: m.text, sub: new Date(m.ts||now()).toLocaleString(), payload:m });
  }
  // Friend requests
  for (const fr of (friendRequestsCache || [])){
    items.push({ kind:"friend", label: `${fr.from} sent you a friend request`, sub: "Accept or Decline", payload:fr.from });
  }
  // Group invites
  for (const gi of (groupInvitesCache || [])){
    items.push({ kind:"invite", label: `${gi.from} invited you to “${gi.name}”`, sub: "Accept or Decline", payload:gi });
  }

  const html = `
    <div style="display:flex;flex-direction:column;gap:10px">
      ${items.length ? items.map((it, idx)=>{
        const right = it.kind === "mention"
          ? `<button class="btn small primary" data-act="mention" data-idx="${idx}">Open</button>`
          : `<div style="display:flex;gap:8px;align-items:center;justify-content:flex-end">
               <button class="btn small primary" data-act="${it.kind}:accept" data-idx="${idx}">Accept</button>
               <button class="btn small" data-act="${it.kind}:decline" data-idx="${idx}">Decline</button>
             </div>`;
        return `
          <div class="row" style="cursor:default">
            <div class="rowLeft">
              <div class="nameCol">
                <div class="rowName">${escapeHtml(it.label)}</div>
                <div class="rowSub">${escapeHtml(it.sub)}</div>
              </div>
            </div>
            ${right}
          </div>
        `;
      }).join("") : `<div class="muted">Nothing here right now.</div>`}
    </div>
  `;

  openModal("Inbox", html);

  modalBody.querySelectorAll("[data-act]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const idx = Number(btn.getAttribute("data-idx"));
      const act = btn.getAttribute("data-act");
      const it = items[idx];
      if (!it) return;

      if (act === "mention"){
        // Open global and clear mentions
        closeModal();
        socket.emit("inbox:clearMentions");
        openGlobal();
        return;
      }

      if (act === "friend:accept"){
        socket.emit("friend:accept", { from: it.payload });
        friendRequestsCache = friendRequestsCache.filter(x=>x.from !== it.payload);
        closeModal();
        return;
      }
      if (act === "friend:decline"){
        socket.emit("friend:decline", { from: it.payload });
        friendRequestsCache = friendRequestsCache.filter(x=>x.from !== it.payload);
        closeModal();
        return;
      }

      if (act === "invite:accept"){
        socket.emit("groupInvite:accept", { id: it.payload.id });
        groupInvitesCache = groupInvitesCache.filter(x=>x.id !== it.payload.id);
        closeModal();
        return;
      }
      if (act === "invite:decline"){
        socket.emit("groupInvite:decline", { id: it.payload.id });
        groupInvitesCache = groupInvitesCache.filter(x=>x.id !== it.payload.id);
        closeModal();
        return;
      }
    });
  });
}

// -------------------- Account Menu --------------------
function openMenu(){
  if (!me) return;

  openModal("Account", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="row" id="menuProfile">
        <div class="rowLeft">
          <div class="iconBox">ME</div>
          <div class="nameCol">
            <div class="rowName">Profile</div>
            <div class="rowSub">view profile + change status</div>
          </div>
        </div>
      </div>

      <div class="row" id="menuSettings">
        <div class="rowLeft">
          <div class="iconBox">SE</div>
          <div class="nameCol">
            <div class="rowName">Settings</div>
            <div class="rowSub">cursor, sounds, filters</div>
          </div>
        </div>
      </div>

      <div class="row" id="menuLogout" style="border-color:rgba(255,82,82,.35)">
        <div class="rowLeft">
          <div class="iconBox">⟂</div>
          <div class="nameCol">
            <div class="rowName">Log out</div>
            <div class="rowSub">end session</div>
          </div>
        </div>
      </div>

      ${isGuest ? `<div class="muted">Guest mode: settings aren’t saved.</div>` : ``}
    </div>
  `);

  const p = $("menuProfile");
  const s = $("menuSettings");
  const l = $("menuLogout");

  if (p) p.onclick = ()=>{ closeModal(); openProfile(me); };
  if (s) s.onclick = ()=>{ closeModal(); openSettings(); };
  if (l) l.onclick = ()=>{ logout(); };
}

// -------------------- Settings --------------------
function openSettings(){
  const cur = settings || {
    density: 0.12,
    cursorMode: "trail",
    reduceAnimations: false,
    sounds: true,
    hideMildProfanity: false
  };

  const draft = {
    cursorMode: cursorMode,
    reduceAnims: reduceAnims,
    hideMildProfanity: !!cur.hideMildProfanity,
    sounds: cur.sounds !== false
  };

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="row" style="cursor:default">
        <div class="rowLeft">
          <div class="iconBox">CU</div>
          <div class="nameCol">
            <div class="rowName">Custom cursor</div>
            <div class="rowSub">Off / Dot / Dot + trail</div>
          </div>
        </div>
        <button class="btn small" id="cursorCycle">Cycle</button>
      </div>

      <div class="row" style="cursor:default">
        <div class="rowLeft">
          <div class="iconBox">AN</div>
          <div class="nameCol">
            <div class="rowName">Reduce animations</div>
            <div class="rowSub">less motion</div>
          </div>
        </div>
        <button class="btn small" id="reduceToggle">${draft.reduceAnims ? "On" : "Off"}</button>
      </div>

      <div class="row" style="cursor:default">
        <div class="rowLeft">
          <div class="iconBox">SO</div>
          <div class="nameCol">
            <div class="rowName">Sounds</div>
            <div class="rowSub">ping on mentions/DM/group</div>
          </div>
        </div>
        <button class="btn small" id="soundToggle">${draft.sounds ? "On" : "Off"}</button>
      </div>

      <div class="row" style="cursor:default">
        <div class="rowLeft">
          <div class="iconBox">FI</div>
          <div class="nameCol">
            <div class="rowName">Hide mild profanity</div>
            <div class="rowSub">mask common swears</div>
          </div>
        </div>
        <button class="btn small" id="filterToggle">${draft.hideMildProfanity ? "On" : "Off"}</button>
      </div>

      <div class="btnRow">
        <button class="btn primary" id="saveSettings">Save</button>
      </div>

      <div class="muted" style="line-height:1.45">
        Do Not Disturb disables notifications regardless of Sounds.
      </div>
    </div>
  `);

  const cursorCycle = $("cursorCycle");
  const reduceToggle = $("reduceToggle");
  const filterToggle = $("filterToggle");
  const soundToggle = $("soundToggle");
  const saveBtn = $("saveSettings");

  function cycleCursor(){
    const order = ["off","dot","trail"];
    const i = Math.max(0, order.indexOf(draft.cursorMode));
    draft.cursorMode = order[(i+1)%order.length];
    setCursorMode(draft.cursorMode);
  }

  if (cursorCycle) cursorCycle.onclick = cycleCursor;
  if (reduceToggle) reduceToggle.onclick = ()=>{
    draft.reduceAnims = !draft.reduceAnims;
    reduceToggle.textContent = draft.reduceAnims ? "On" : "Off";
    reduceAnims = draft.reduceAnims;
  };
  if (soundToggle) soundToggle.onclick = ()=>{
    draft.sounds = !draft.sounds;
    soundToggle.textContent = draft.sounds ? "On" : "Off";
  };
  if (filterToggle) filterToggle.onclick = ()=>{
    draft.hideMildProfanity = !draft.hideMildProfanity;
    filterToggle.textContent = draft.hideMildProfanity ? "On" : "Off";
  };

  if (saveBtn) saveBtn.onclick = ()=>{
    window.__savedReduceAnims = draft.reduceAnims;
    window.__savedCursorMode = draft.cursorMode;

    reduceAnims = draft.reduceAnims;
    setCursorMode(draft.cursorMode);

    if (!isGuest){
      settings = settings || {};
      settings.reduceAnimations = draft.reduceAnims;
      settings.cursorMode = draft.cursorMode;
      settings.sounds = draft.sounds;
      settings.hideMildProfanity = draft.hideMildProfanity;
      socket.emit("settings:update", settings);
    }

    closeModal();
  };
}

function logout(){
  showLoading("logging out…");
  setTimeout(()=>{
    localStorage.removeItem("tonkotsu_token");
    location.reload();
  }, reduceAnims ? 220 : 420);
}

// -------------------- Profile (friend request + status dropdown if self) --------------------
function friendState(target){
  if (!social) return "unknown";
  if (social.friends?.includes(target)) return "friends";
  if (social.outgoing?.includes(target)) return "outgoing";
  if (social.incoming?.includes(target)) return "incoming";
  if (social.blocked?.includes(target)) return "blocked";
  return "none";
}

function openProfile(user){
  if (!user) return;

  const isSelf = (user === me);
  const isGuestUser = /^Guest\d{4,5}$/.test(String(user));

  const st = friendState(user);

  const statusBlock = (!isGuestUser && isSelf && !isGuest)
    ? `
      <div style="border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;font-size:12px;margin-bottom:8px">Status</div>
        <select class="field" id="statusSelect">
          <option value="online">Online</option>
          <option value="idle">Idle</option>
          <option value="dnd">Do Not Disturb</option>
          <option value="invisible">Offline</option>
        </select>
        <div class="muted" style="margin-top:8px;line-height:1.45">
          Idle auto-turns on after 3 minutes of inactivity when you are Online.
        </div>
      </div>
    `
    : ``;

  // Friend request button rules:
  // - none -> Add friend (sends request, appears in their inbox)
  // - outgoing -> Request sent (disabled)
  // - incoming -> Accept request
  // - friends -> Friends (disabled)
  // - blocked -> Unblock
  const actionBlock = (!isGuestUser && !isSelf && !isGuest)
    ? `
      <div class="btnRow">
        <button class="btn" id="profDM">DM</button>

        ${
          st === "none" ? `<button class="btn primary" id="profAdd">Add friend</button>` :
          st === "outgoing" ? `<button class="btn primary" id="profAdd" disabled>Request sent</button>` :
          st === "incoming" ? `<button class="btn primary" id="profAccept">Accept request</button>` :
          st === "friends" ? `<button class="btn primary" disabled>Friends</button>` :
          st === "blocked" ? `<button class="btn primary" id="profUnblock">Unblock</button>` :
          `<button class="btn primary" id="profAdd">Add friend</button>`
        }

        ${st !== "blocked" ? `<button class="btn" id="profBlock">Block</button>` : ``}
      </div>
    `
    : ``;

  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="min-width:0">
        <div style="font-weight:950;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(user)}</div>
        <div class="muted" id="profSub">${isGuestUser ? "Guest user" : "loading…"}</div>
      </div>

      ${isGuestUser ? "" : `
        <div style="border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
          <div style="font-weight:950;font-size:12px;margin-bottom:8px">Account</div>
          <div id="profStats" class="muted" style="display:flex;flex-direction:column;gap:6px">loading…</div>
        </div>
      `}

      ${statusBlock}
      ${actionBlock}

      ${(!isGuestUser && isSelf && !isGuest) ? `
        <div style="border-top:1px solid var(--stroke);padding-top:10px">
          <div class="row" id="deleteAccountRow" style="border-color:rgba(255,82,82,.35)">
            <div class="rowLeft">
              <div class="iconBox">!!</div>
              <div class="nameCol">
                <div class="rowName">Delete account</div>
                <div class="rowSub">permanent</div>
              </div>
            </div>
          </div>
        </div>
      ` : ``}
    </div>
  `);

  if (!isGuestUser){
    modalBody._profileUser = user;
    socket.emit("profile:get", { user });

    setTimeout(()=>{
      const sel = $("statusSelect");
      if (sel){
        sel.value = (myStatus || "online");
        sel.onchange = ()=>{
          const v = sel.value;
          manualStatus = true;
          autoIdleEngaged = false;
          socket.emit("status:set", { status: v });
        };
      }

      const dmBtn = $("profDM");
      if (dmBtn) dmBtn.onclick = ()=>{ closeModal(); openDM(user); };

      const addBtn = $("profAdd");
      if (addBtn && !addBtn.disabled) addBtn.onclick = ()=>{
        socket.emit("friend:request", { to:user });
      };

      const acceptBtn = $("profAccept");
      if (acceptBtn) acceptBtn.onclick = ()=>{
        socket.emit("friend:accept", { from:user });
        closeModal();
      };

      const blkBtn = $("profBlock");
      if (blkBtn) blkBtn.onclick = ()=>{ socket.emit("user:block", { user }); closeModal(); };

      const unb = $("profUnblock");
      if (unb) unb.onclick = ()=>{ socket.emit("user:unblock", { user }); closeModal(); };

      const delRow = $("deleteAccountRow");
      if (delRow){
        delRow.onclick = ()=>{
          openModal("Delete account", `
            <div class="muted" style="line-height:1.45">
              Are you sure you want to delete your account? This cannot be undone.
            </div>
            <div class="btnRow" style="margin-top:12px">
              <button class="btn" id="delCancel">Cancel</button>
              <button class="btn primary" id="delConfirm" style="border-color:rgba(255,82,82,.45)">Delete</button>
            </div>
          `);
          const c = $("delCancel");
          const y = $("delConfirm");
          if (c) c.onclick = ()=>{ closeModal(); openProfile(me); };
          if (y) y.onclick = ()=>{
            socket.emit("account:delete");
            showLoading("deleting…");
          };
        };
      }
    }, 0);
  }
}

// -------------------- Group info --------------------
function openGroupInfo(groupId){
  const meta = groupMeta.get(groupId);
  if (!meta){
    openModal("Group", `<div class="muted">No group info available.</div>`);
    return;
  }

  const members = Array.isArray(meta.members) ? meta.members : [];
  const memberList = members.slice(0, 60).map(u=>`<div class="muted">${escapeHtml(u)}</div>`).join("");
  const more = members.length > 60 ? `<div class="muted">…and ${members.length - 60} more</div>` : ``;

  const ownerControls = (!isGuest && meta.owner === me)
    ? `
      <div style="border-top:1px solid var(--stroke);padding-top:10px;display:flex;flex-direction:column;gap:10px">
        <div style="font-weight:950">Owner tools</div>
        <div class="muted">Max members is 200.</div>

        <div class="muted">Add member (letters/numbers only)</div>
        <input class="field" id="addMemberName" placeholder="username" />
        <div class="btnRow">
          <button class="btn primary" id="addMemberBtn">Add</button>
        </div>

        <div class="row" id="leaveGroupRow" style="border-color:rgba(255,82,82,.35)">
          <div class="rowLeft">
            <div class="iconBox">!!</div>
            <div class="nameCol">
              <div class="rowName">Delete group</div>
              <div class="rowSub">owner only</div>
            </div>
          </div>
        </div>
      </div>
    `
    : `
      <div style="border-top:1px solid var(--stroke);padding-top:10px">
        <div class="row" id="leaveGroupRow" style="border-color:rgba(255,82,82,.35)">
          <div class="rowLeft">
            <div class="iconBox">⟂</div>
            <div class="nameCol">
              <div class="rowName">Leave group</div>
              <div class="rowSub">remove yourself</div>
            </div>
          </div>
        </div>
      </div>
    `;

  openModal("Group info", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;font-size:14px">${escapeHtml(meta.name)}</div>
        <div class="muted" style="margin-top:6px">Owner: ${escapeHtml(meta.owner)}</div>
        <div class="muted">Members: ${members.length} / 200</div>
        <div class="muted">ID: ${escapeHtml(meta.id)}</div>
      </div>

      <div style="border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;margin-bottom:8px">Members</div>
        <div style="display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto">
          ${memberList || `<div class="muted">No members found.</div>`}
          ${more}
        </div>
      </div>

      ${ownerControls}
    </div>
  `);

  const leaveRow = $("leaveGroupRow");
  if (leaveRow){
    leaveRow.onclick = ()=>{
      if (!isGuest && meta.owner === me){
        openModal("Delete group", `
          <div class="muted" style="line-height:1.45">
            Are you sure you want to delete this group? This removes it for everyone.
          </div>
          <div class="btnRow" style="margin-top:12px">
            <button class="btn" id="gDelCancel">Cancel</button>
            <button class="btn primary" id="gDelConfirm" style="border-color:rgba(255,82,82,.45)">Delete</button>
          </div>
        `);
        const c = $("gDelCancel");
        const y = $("gDelConfirm");
        if (c) c.onclick = ()=>{ closeModal(); openGroupInfo(groupId); };
        if (y) y.onclick = ()=>{ socket.emit("group:delete", { groupId }); closeModal(); };
      } else {
        socket.emit("group:leave", { groupId });
        closeModal();
      }
    };
  }

  const addBtn = $("addMemberBtn");
  if (addBtn){
    addBtn.onclick = ()=>{
      const name = ($("addMemberName")?.value || "").trim();
      if (!credValid(name)){
        toast("Invalid", "Username must be letters/numbers only (min 4).");
        return;
      }
      socket.emit("group:addMember", { groupId, user: name });
      const el = $("addMemberName");
      if (el) el.value = "";
    };
  }
}

// -------------------- Group creation --------------------
function openCreateGroup(){
  if (isGuest){
    toast("Guests","Guests can’t create groups.");
    return;
  }

  openModal("Create group", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="muted">Group name</div>
      <input class="field" id="gcName" placeholder="Unnamed Group" />

      <div class="muted">Invite at least 1 user (comma separated, max 199 invites)</div>
      <input class="field" id="gcInv" placeholder="user1, user2" />

      <div class="btnRow">
        <button class="btn primary" id="gcGo">Send invites</button>
      </div>

      <div class="muted" style="line-height:1.45">
        Group becomes active after someone accepts. Hard cap is 200 members.
      </div>
    </div>
  `);

  const go = $("gcGo");
  if (go) go.onclick = ()=>{
    const name = ($("gcName")?.value || "").trim();
    const invitesRaw = ($("gcInv")?.value || "").trim();
    const invites = invitesRaw.split(",").map(s=>s.trim()).filter(Boolean);

    const unique = Array.from(new Set(invites)).slice(0, 199);
    if (unique.length < 1){
      toast("Group", "Invite at least 1 person.");
      return;
    }
    for (const u of unique){
      if (!credValid(u)){
        toast("Invalid", `Bad username in invites: ${u}`);
        return;
      }
    }

    closeModal();
    socket.emit("group:createRequest", { name, invites: unique });
  };
}

// -------------------- Sending --------------------
function sendCurrent(){
  if (!me) return;
  const text = (messageEl?.value || "").trim();
  if (!text) return;

  if (!canSend()){
    cooldownWarn();
    return;
  }

  startCooldown();
  messageEl.value = "";

  if (view.type === "global"){
    socket.emit("sendGlobal", { text, ts: now() });
  } else if (view.type === "dm"){
    socket.emit("dm:send", { to: currentDM, text });
  } else if (view.type === "group"){
    socket.emit("group:send", { groupId: currentGroupId, text });
  }
}

if (sendBtn) sendBtn.addEventListener("click", sendCurrent);
if (messageEl){
  messageEl.addEventListener("keydown",(e)=>{
    if (e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      sendCurrent();
    }
  });
}

// -------------------- Login --------------------
if (togglePass && passwordEl){
  togglePass.addEventListener("click", ()=>{
    const isPw = passwordEl.type === "password";
    passwordEl.type = isPw ? "text" : "password";
    togglePass.textContent = isPw ? "◎" : "◉";
  });
}

function tryResume(){
  if (token){
    showLoading("resuming session…");
    socket.emit("resume", { token });
  }
}

if (joinBtn){
  joinBtn.addEventListener("click", ()=>{
    const u = (usernameEl?.value || "").trim();
    const p = (passwordEl?.value || "");

    if (!credValid(u)){
      toast("Invalid username", "Use letters/numbers only (min 4).");
      return;
    }
    if (!passValid(p)){
      toast("Invalid password", "Use letters/numbers only (min 4).");
      return;
    }

    showLoading("logging in…");
    socket.emit("login", { username:u, password:p, guest:false });
  });
}

if (guestBtn){
  guestBtn.addEventListener("click", ()=>{
    showLoading("joining as guest…");
    socket.emit("login", { guest:true });
  });
}

if (passwordEl && joinBtn){
  passwordEl.addEventListener("keydown",(e)=>{
    if (e.key === "Enter") joinBtn.click();
  });
}

// -------------------- UI binds --------------------
if (inboxBtn) inboxBtn.addEventListener("click", openInbox);
if (createGroupBtn) createGroupBtn.addEventListener("click", openCreateGroup);
if (mePill) mePill.addEventListener("click", openMenu);

if (onlineToggle && onlineWrap){
  onlineToggle.addEventListener("click", ()=>{
    onlineWrap.classList.toggle("collapsed");
  });
}

// -------------------- Socket events --------------------
socket.on("resumeFail", ()=>{
  localStorage.removeItem("tonkotsu_token");
  token = null;
  hideLoading();
});

socket.on("loginError",(msg)=>{
  hideLoading();
  loginCard?.classList.add("shake");
  setTimeout(()=> loginCard?.classList.remove("shake"), 350);
  toast("Login failed", msg || "Try again.");
});

socket.on("loginSuccess",(data)=>{
  // Transition: keep loading for a beat, then hide overlay
  showLoading("initializing…");

  me = data.username;
  isGuest = !!data.guest;

  settings = data.settings || settings || { cursorMode:"trail", reduceAnimations:false, sounds:true, hideMildProfanity:false };
  social = data.social || social || { friends:[], incoming:[], outgoing:[], blocked:[] };

  myStatus = data.status || "online";
  manualStatus = false;
  autoIdleEngaged = false;

  if (!isGuest && data.token){
    localStorage.setItem("tonkotsu_token", data.token);
    token = data.token;
  }

  const savedMode = window.__savedCursorMode || settings.cursorMode || "trail";
  setCursorMode(savedMode);
  reduceAnims = !!window.__savedReduceAnims || !!settings.reduceAnimations;

  if (cooldownLabel) cooldownLabel.textContent = `Cooldown: ${cooldownSeconds()}s`;

  if (mePill) mePill.style.display = "flex";
  if (meName) meName.textContent = me;
  if (meSub) meSub.textContent = isGuest ? "Guest" : "click for menu";

  applyMyStatusUI();

  // Finalize transition
  setTimeout(()=>{
    if (loginOverlay) loginOverlay.classList.add("hidden");
    openGlobal();
    if (!isGuest){
      socket.emit("social:sync");
      socket.emit("groups:list");
      socket.emit("inbox:get");
    }
    renderMessagesList();
    hideLoading();
  }, reduceAnims ? 120 : 260);
});

socket.on("settings",(s)=>{
  settings = s || settings;
  if (settings?.cursorMode){
    window.__savedCursorMode = settings.cursorMode;
    setCursorMode(settings.cursorMode);
  }
  if (typeof settings?.reduceAnimations === "boolean"){
    window.__savedReduceAnims = settings.reduceAnimations;
    reduceAnims = settings.reduceAnimations;
  }
});

socket.on("status:update",({ status }={})=>{
  if (!status) return;
  myStatus = status;
  applyMyStatusUI();
});

// This is the lightweight badge event (counts only)
socket.on("inbox:badge",(counts)=>{
  inboxCounts = counts || inboxCounts;
  unreadGlobalMentions = Number(inboxCounts?.ment || 0); // show mentions on Global entry
  updateBadges();
  renderMessagesList();
});

socket.on("social:update",(s)=>{
  social = s || social;
  updateBadges();
});

socket.on("inbox:data",(data)=>{
  const items = Array.isArray(data?.items) ? data.items : [];
  inboxMentionsCache = items.filter(x=>x.type==="mention");
  groupInvitesCache = items.filter(x=>x.type==="group").map(x=>({
    id: x.id,
    from: x.from,
    name: (x.text || "").match(/“(.+?)”/)?.[1] || "Group",
    ts: x.ts
  }));
  friendRequestsCache = items.filter(x=>x.type==="friend").map(x=>({ from: x.from, ts: x.ts }));

  // Update badge counts from this payload as well (fallback if badge event lags)
  const friend = friendRequestsCache.length;
  const groupInv = groupInvitesCache.length;
  const ment = inboxMentionsCache.length;
  inboxCounts = { total: friend + groupInv + ment, friend, groupInv, ment };
  unreadGlobalMentions = ment;

  updateBadges();
  renderMessagesList();
});

socket.on("onlineUsers",(list)=>{
  onlineUsers = Array.isArray(list) ? list : [];
  renderOnline();
  renderMessagesList();

  const mine = onlineUsers.find(x=>x.user===me);
  if (mine?.status){
    myStatus = mine.status;
    applyMyStatusUI();
  }
});

socket.on("history",(msgs)=>{
  globalCache = Array.isArray(msgs) ? msgs : [];
  if (view.type === "global"){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m,"global"));
  }
});

socket.on("globalMessage",(msg)=>{
  if (!msg) return;
  globalCache.push(msg);
  if (globalCache.length > 300) globalCache.shift();
  if (view.type === "global") addMessageToUI(msg,"global");

  // If this message includes a mention of me and I'm not currently viewing global,
  // you get the unread mention badge on global + inbox mention storage from server.
  // The server will emit inbox:badge; this just adds immediate feedback.
  if (me && view.type !== "global" && typeof msg.text === "string" && msg.text.toLowerCase().includes(`@${me.toLowerCase()}`)){
    pingSound();
    toast("Mention", `@${me} mentioned in Global`);
  }
});

socket.on("dm:history",({ withUser, msgs }={})=>{
  const other = withUser;
  const list = Array.isArray(msgs) ? msgs : [];
  dmCache.set(other, list);

  if (view.type === "dm" && currentDM === other){
    clearChat();
    list.forEach(m=> addMessageToUI({user: m.user, text:m.text, ts:m.ts},"dm"));
  }
  renderMessagesList();
});

socket.on("dm:message",({ from, msg }={})=>{
  if (!from || !msg) return;

  const other = from;
  if (!dmCache.has(other)) dmCache.set(other, []);
  dmCache.get(other).push(msg);
  if (dmCache.get(other).length > 250) dmCache.get(other).shift();

  const inThatDM = (view.type==="dm" && currentDM===other);

  if (!inThatDM){
    unreadDM.set(other, (unreadDM.get(other)||0) + 1);
    updateBadges();
    pingSound();
    toast("DM", `${other}: ${String(msg.text||"").slice(0, 80)}`);
  } else {
    addMessageToUI({user: msg.user, text: msg.text, ts: msg.ts},"dm");
  }

  renderMessagesList();
});

socket.on("groups:list",(list)=>{
  groupMeta.clear();
  (Array.isArray(list)?list:[]).forEach(g=>{
    groupMeta.set(g.id, { id:g.id, name:g.name, owner:g.owner, members:g.members||[] });
  });
  renderMessagesList();
});

socket.on("group:history",({ groupId, meta, msgs }={})=>{
  if (!groupId) return;
  if (meta) groupMeta.set(groupId, meta);
  groupCache.set(groupId, Array.isArray(msgs)?msgs:[]);

  setView("group", groupId);
  clearChat();
  (msgs||[]).forEach(m=> addMessageToUI(m,"group"));
  renderMessagesList();
});

socket.on("group:message",({ groupId, msg }={})=>{
  if (!groupId || !msg) return;

  if (!groupCache.has(groupId)) groupCache.set(groupId, []);
  groupCache.get(groupId).push(msg);

  const inThatGroup = (view.type==="group" && currentGroupId===groupId);

  if (!inThatGroup){
    unreadGroup.set(groupId, (unreadGroup.get(groupId)||0) + 1);
    updateBadges();
    pingSound();
    const gname = groupMeta.get(groupId)?.name || "Group";
    toast("Group", `${gname}: ${String(msg.text||"").slice(0, 80)}`);
  } else {
    addMessageToUI(msg,"group");
  }

  renderMessagesList();
});

socket.on("group:meta",({ groupId, meta, name, owner, members }={})=>{
  if (!groupId) return;
  const incoming = meta || { id:groupId, name, owner, members };
  const m = groupMeta.get(groupId) || { id:groupId, name:"Unnamed Group", owner:"—", members:[] };
  if (incoming.name) m.name = incoming.name;
  if (incoming.owner) m.owner = incoming.owner;
  if (Array.isArray(incoming.members)) m.members = incoming.members;
  groupMeta.set(groupId, m);

  if (view.type==="group" && currentGroupId===groupId){
    chatTitle.textContent = `Group — ${m.name}`;
    chatTitle.classList.add("clickable");
    chatTitle.onclick = ()=> openGroupInfo(groupId);
  }
  renderMessagesList();
});

socket.on("group:left",({ groupId }={})=>{
  unreadGroup.delete(groupId);
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  updateBadges();
  openGlobal();
  socket.emit("groups:list");
});

socket.on("group:deleted",({ groupId }={})=>{
  unreadGroup.delete(groupId);
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  updateBadges();
  openGlobal();
  socket.emit("groups:list");
});

socket.on("profile:data",(p)=>{
  const target = modalBody?._profileUser;
  if (!target || !p || p.user !== target) return;

  const sub = $("profSub");
  const stats = $("profStats");
  if (p.guest){
    if (sub) sub.textContent = "Guest user";
    if (stats) stats.innerHTML = "";
    return;
  }

  const created = p.createdAt ? new Date(p.createdAt).toLocaleString() : "—";
  const level = Number.isFinite(p.level) ? p.level : 1;
  const xpNow = Number.isFinite(p.xp) ? p.xp : 0;
  const xpNext = Number.isFinite(p.next) ? p.next : 120;
  const msgs = Number.isFinite(p.messages) ? p.messages : 0;
  const st = p.status || "online";

  if (sub) sub.textContent = `Status: ${labelForStatus(st)} • Level ${level} • ${msgs} messages`;

  const pct = xpNext > 0 ? clamp(xpNow/xpNext, 0, 1) : 0;

  if (stats){
    stats.innerHTML = `
      <div><b style="color:var(--text)">Created:</b> ${escapeHtml(created)}</div>
      <div><b style="color:var(--text)">Messages:</b> ${msgs}</div>
      <div><b style="color:var(--text)">Status:</b> ${escapeHtml(labelForStatus(st))}</div>
      <div style="margin-top:8px">
        <div style="display:flex;justify-content:space-between;gap:10px">
          <div>XP</div><div>${xpNow}/${xpNext}</div>
        </div>
        <div style="margin-top:6px;height:10px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);overflow:hidden">
          <div style="height:100%;width:${Math.round(pct*100)}%;background:rgba(255,255,255,.18)"></div>
        </div>
      </div>
    `;
  }

  const sel = $("statusSelect");
  if (sel && me === target){
    sel.value = st === "invisible" ? "invisible" : st;
  }
});

socket.on("sendError",({ reason }={})=>{
  if (reason) toast("Error", reason);
});

// -------------------- Init --------------------
setCursorMode("trail");
requestAnimationFrame(cursorTick);
tryResume();
idleTick();

setView("global");
renderOnline();
renderMessagesList();

// Default: load global history in background (only shown after login)
socket.emit("requestGlobalHistory");

