/* public/script.js — highly animated, compact black UI
   - Custom cursor applied from first paint
   - Login overlay is pure black with dot stars behind it
   - Global chat lives in the Messages list (first item)
   - DND: no notifications (sound/toast) when status is dnd
   - Idle auto after 3 minutes inactivity when online (non-guest)
   - Status change only in your profile (dropdown)
   - Group info by clicking group title in topbar
   - Group cap: 200 (enforced server-side)
   - Strict credentials (alnum only, min 4)
   - No bots
*/

const socket = io();
const $ = (id) => document.getElementById(id);

// -------------------- DOM --------------------
const card = $("card");

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

// Cursor
const cursor = document.getElementById("cursor");
const cursor2 = document.getElementById("cursor2");

// -------------------- State --------------------
let me = null;
let isGuest = false;
let token = localStorage.getItem("tonkotsu_token") || null;

let settings = { sounds: true, hideMildProfanity: false };
let social = { friends:[], incoming:[], outgoing:[], blocked:[] };

let myStatus = "online";
let manualStatus = false;
let autoIdleEngaged = false;

let view = { type:"global", id:null };
let currentDM = null;
let currentGroupId = null;

let onlineUsers = [];
let globalCache = [];
let dmCache = new Map();
let groupCache = new Map();
let groupMeta = new Map();

let unreadDM = new Map();
let unreadGroup = new Map();
let unreadGlobalMentions = 0;

let inboxMentionsCache = [];
let friendRequestsCache = [];
let groupInvitesCache = [];
let inboxCounts = { total:0, friend:0, groupInv:0, ment:0 };

let cooldownUntil = 0;

// -------------------- Utils --------------------
function now(){ return Date.now(); }
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function fmtTime(ts){
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
}

function isValidUser(u){ return /^[A-Za-z0-9]{4,20}$/.test(String(u||"").trim()); }
function isValidPass(p){ return /^[A-Za-z0-9]{4,32}$/.test(String(p||"").trim()); }
function isGuestName(u){ return /^Guest\d{4,5}$/.test(String(u||"")); }

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
  if (st === "invisible") return "Offline";
  return "Offline";
}

function icon(name){
  const wrap = (paths)=> `
    <span class="ico" aria-hidden="true">
      <svg viewBox="0 0 24 24">${paths}</svg>
    </span>
  `;
  if (name === "global") return wrap(`<path d="M12 2a10 10 0 1 0 0 20"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20"/>`);
  if (name === "dm") return wrap(`<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>`);
  if (name === "group") return wrap(`<path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"/><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`);
  if (name === "chev") return wrap(`<path d="M6 9l6 6 6-6"/>`);
  if (name === "spark") return wrap(`<path d="M12 2 9 9l-7 3 7 3 3 7 3-7 7-3-7-3z"/>`);
  return wrap(`<path d="M12 5v14"/><path d="M5 12h14"/>`);
}

// -------------------- Cursor --------------------
(function initCursor(){
  if (!cursor || !cursor2) return;

  let x = window.innerWidth/2, y = window.innerHeight/2;
  let x2 = x, y2 = y;

  function setOpacity(on){
    cursor.style.opacity = on ? "1" : "0";
    cursor2.style.opacity = on ? "1" : "0";
  }

  setOpacity(true);

  window.addEventListener("mouseenter", ()=> setOpacity(true));
  window.addEventListener("mouseleave", ()=> setOpacity(false));

  window.addEventListener("mousemove",(e)=>{
    x = e.clientX; y = e.clientY;
  }, { passive:true });

  function tick(){
    // trailing cursor2
    x2 += (x - x2) * 0.18;
    y2 += (y - y2) * 0.18;

    cursor.style.transform = `translate(${x}px, ${y}px) translate(-50%,-50%)`;
    cursor2.style.transform = `translate(${x2}px, ${y2}px) translate(-50%,-50%)`;

    requestAnimationFrame(tick);
  }
  tick();

  window.addEventListener("mousedown", ()=> document.body.classList.add("cursorPress"));
  window.addEventListener("mouseup", ()=> document.body.classList.remove("cursorPress"));

  // hover states
  const hoverSelector = ".btn, .row, a, .chatTitle.clickable";
  const textSelector = "input, textarea, .field";

  function bindHover(){
    document.querySelectorAll(hoverSelector).forEach(el=>{
      if (el.__cursorBound) return;
      el.__cursorBound = true;
      el.addEventListener("mouseenter", ()=> document.body.classList.add("cursorHover"));
      el.addEventListener("mouseleave", ()=> document.body.classList.remove("cursorHover"));
    });
    document.querySelectorAll(textSelector).forEach(el=>{
      if (el.__cursorTextBound) return;
      el.__cursorTextBound = true;
      el.addEventListener("mouseenter", ()=> document.body.classList.add("cursorText"));
      el.addEventListener("mouseleave", ()=> document.body.classList.remove("cursorText"));
    });
  }
  bindHover();

  // rebinding after dynamic render
  window.__bindCursorHover = bindHover;
})();

// -------------------- Animation helpers --------------------
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
  setTimeout(()=> chatBox.classList.remove("fading"), 160);
}
function staggerIn(container){
  if (!container) return;
  const kids = Array.from(container.children);
  kids.forEach((el, i)=>{
    el.style.opacity = "0";
    el.style.transform = "translateY(10px)";
    el.style.filter = "blur(1px)";
    el.style.transition = "opacity 220ms cubic-bezier(.2,.85,.2,1), transform 220ms cubic-bezier(.2,.85,.2,1), filter 220ms cubic-bezier(.2,.85,.2,1)";
    setTimeout(()=>{
      el.style.opacity = "1";
      el.style.transform = "translateY(0)";
      el.style.filter = "blur(0)";
    }, 28 * i);
  });
}
function attachRipple(root=document){
  root.querySelectorAll(".btn, .row").forEach(el=>{
    if (el.__rippleBound) return;
    el.__rippleBound = true;
    el.addEventListener("pointerdown",(e)=>{
      if (el.disabled) return;
      const rect = el.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const r = document.createElement("span");
      r.className = "ripple";
      r.style.left = x + "px";
      r.style.top = y + "px";
      el.appendChild(r);
      setTimeout(()=> r.remove(), 520);
    }, { passive:true });
  });
  if (window.__bindCursorHover) window.__bindCursorHover();
}
attachRipple();

// -------------------- Notifications --------------------
function canNotify(){
  // DND disables all notifications
  if (myStatus === "dnd") return false;
  // Invisible behaves like offline (no notifs)
  if (myStatus === "invisible") return false;
  return true;
}
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

  setTimeout(()=>{
    d.style.opacity="0";
    d.style.transform="translateY(10px)";
    d.style.filter="blur(1px)";
  }, 2600);

  setTimeout(()=> d.remove(), 2950);
}

// -------------------- Modal --------------------
function openModal(title, html){
  if (!modalBack || !modalTitle || !modalBody) return;
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalBack.classList.add("show");
  attachRipple(modalBody);
}
function closeModal(){
  if (!modalBack) return;
  modalBack.classList.remove("show");
  if (modalBody) modalBody.innerHTML = "";
}
if (modalClose) modalClose.addEventListener("click", closeModal);
if (modalBack) modalBack.addEventListener("click",(e)=>{ if(e.target===modalBack) closeModal(); });

// -------------------- Profanity mask (optional) --------------------
const MILD_WORDS = ["fuck","fucking","shit","shitty","asshole","bitch","bastard","dick","pussy"];
const MILD_RX = new RegExp(`\\b(${MILD_WORDS.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})\\b`, "ig");
function maybeHideMild(text){
  if (!settings?.hideMildProfanity) return text;
  return String(text).replace(MILD_RX, "•••");
}

function isBlockedUser(u){
  return !!social?.blocked?.includes(u);
}

// -------------------- Status UI --------------------
function applyMyStatusUI(){
  if (statusLabel) statusLabel.textContent = `Status: ${labelForStatus(myStatus)}`;
  if (meStatusDot) meStatusDot.className = `statusDot ${dotClassForStatus(myStatus === "invisible" ? "offline" : myStatus)}`;
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
  setTimeout(()=> cooldownRow.classList.remove("shake"), 320);
  setTimeout(()=> cooldownRow.classList.remove("warn"), 900);
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
  setTimeout(idleTick, 1200);
}

// -------------------- View / rendering --------------------
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
  if (window.__bindCursorHover) window.__bindCursorHover();
}

function clearChat(){
  if (chatBox) chatBox.innerHTML = "";
}

function renderTextWithMentions(text){
  if (!me) return escapeHtml(text);
  const safe = escapeHtml(text);
  const rx = new RegExp(`(@${me.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`, "ig");
  return safe.replace(rx, `<span class="mention">$1</span>`);
}

function addMessageToUI({ user, text, ts }, scope){
  if (!chatBox) return;

  let bodyText = String(text ?? "");

  // blocked user in global = hidden by default (reveal button)
  const isBlocked = (scope === "global" && user && isBlockedUser(user));

  if (!isBlocked) bodyText = maybeHideMild(bodyText);

  const time = fmtTime(ts);

  const row = document.createElement("div");
  row.className = "msg";

  const revealBtn = isBlocked
    ? `<div style="margin-top:10px"><button class="btn small primary" data-reveal="1">${icon("spark")}<span>Reveal</span></button></div>`
    : ``;

  const bodyHTML = isBlocked
    ? `<div class="body" style="filter:blur(7px);opacity:.55" data-body="1">${renderTextWithMentions("Message hidden (blocked user).")}</div>${revealBtn}`
    : `<div class="body">${renderTextWithMentions(bodyText)}</div>`;

  row.innerHTML = `
    <div class="bubble">
      <div class="meta">
        <div class="u" data-user="${escapeHtml(user)}">${escapeHtml(user)}${(user===me?" (You)":"")}</div>
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
  attachRipple(row);
}

// -------------------- Sidebar rendering --------------------
function renderOnline(){
  if (!onlineList) return;
  if (onlineCount) onlineCount.textContent = String(onlineUsers.length);

  onlineList.innerHTML = onlineUsers.map((u)=>{
    const name = u.user;
    const st = u.status || "online";
    return `
      <div class="row" data-open-profile="${escapeHtml(name)}" style="height:40px">
        <div class="rowLeft">
          <div class="statusDot ${escapeHtml(dotClassForStatus(st))}"></div>
          <div class="nameCol">
            <div class="rowName">${escapeHtml(name)}${name===me?" (You)":""}</div>
            <div class="rowSub">${escapeHtml(labelForStatus(st))}</div>
          </div>
        </div>
        ${icon("chev")}
      </div>
    `;
  }).join("");

  onlineList.querySelectorAll("[data-open-profile]").forEach(el=>{
    el.addEventListener("click", ()=>{
      openProfile(el.getAttribute("data-open-profile"));
    });
  });

  attachRipple(onlineList);
  staggerIn(onlineList);
}

function totalMessagePings(){
  let n = 0;
  for (const v of unreadDM.values()) n += v;
  for (const v of unreadGroup.values()) n += v;
  return n;
}
function updateBadges(){
  const m = totalMessagePings() + (unreadGlobalMentions || 0);
  if (msgPing){
    msgPing.textContent = String(m);
    msgPing.classList.toggle("show", m > 0);
  }

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

  const globalBadge = unreadGlobalMentions || 0;

  msgList.innerHTML = `
    <!-- Global is inside Messages -->
    <div class="row" data-open="global">
      <div class="rowLeft">
        ${icon("global")}
        <div class="nameCol">
          <div class="rowName">Global chat</div>
          <div class="rowSub">shared</div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div class="badge ${globalBadge>0?"show":""}" style="display:${globalBadge>0?"flex":"none"}">${globalBadge}</div>
        ${icon("chev")}
      </div>
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
          <div style="display:flex;align-items:center;gap:10px">
            <div class="badge ${c>0?"show":""}" style="display:${c>0?"flex":"none"}">${c}</div>
            ${icon("chev")}
          </div>
        </div>
      `;
    }).join("")}

    ${groups.map(g=>{
      const c = unreadGroup.get(g.id) || 0;
      const members = Array.isArray(g.members) ? g.members.length : 0;
      return `
        <div class="row" data-open="group" data-id="${escapeHtml(g.id)}">
          <div class="rowLeft">
            ${icon("group")}
            <div class="nameCol">
              <div class="rowName">${escapeHtml(g.name)}</div>
              <div class="rowSub">${members} members</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <div class="badge ${c>0?"show":""}" style="display:${c>0?"flex":"none"}">${c}</div>
            ${icon("chev")}
          </div>
        </div>
      `;
    }).join("")}
  `;

  msgList.querySelectorAll("[data-open]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const t = el.getAttribute("data-open");
      const id = el.getAttribute("data-id");
      if (t === "global") openGlobal();
      if (t === "dm") openDM(id);
      if (t === "group") openGroup(id);
    });
  });

  attachRipple(msgList);
  staggerIn(msgList);
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

    unreadGlobalMentions = 0;
    updateBadges();
    renderMessagesList();

    hideLoading();
  }, 170);
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
  }, 170);
}

function openGroup(gid){
  if (isGuest){
    toast("Guests", "Guests can’t join groups. Log in to use groups.");
    return;
  }
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
  }, 170);
}

// -------------------- Inbox --------------------
function openInbox(){
  if (isGuest){
    openModal("Inbox", `<div class="muted">Guest mode has no inbox.</div>`);
    return;
  }

  socket.emit("inbox:get");

  const items = [];

  for (const m of (inboxMentionsCache || [])){
    items.push({ kind:"mention", label: m.text, sub: new Date(m.ts||now()).toLocaleString(), payload:m });
  }
  for (const fr of (friendRequestsCache || [])){
    items.push({ kind:"friend", label: `${fr.from} sent you a friend request`, sub: "Accept or Decline", payload:fr.from });
  }
  for (const gi of (groupInvitesCache || [])){
    items.push({ kind:"invite", label: `${gi.from} invited you to “${gi.name}”`, sub: "Accept or Decline", payload:gi });
  }

  const html = `
    <div style="display:flex;flex-direction:column;gap:10px">
      ${items.length ? items.map((it, idx)=>{
        const right = it.kind === "mention"
          ? `<button class="btn small primary" data-act="mention" data-idx="${idx}">${icon("spark")}<span>Open</span></button>`
          : `<div style="display:flex;align-items:center;gap:10px">
               <button class="btn small primary" data-act="${it.kind}:accept" data-idx="${idx}"><span>Accept</span></button>
               <button class="btn small" data-act="${it.kind}:decline" data-idx="${idx}"><span>Decline</span></button>
             </div>`;
        return `
          <div class="row" style="height:auto; padding:10px; cursor:default">
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
        closeModal();
        socket.emit("inbox:clearMentions");
        openGlobal();
        return;
      }

      if (act === "friend:accept"){
        socket.emit("friend:accept", { from: it.payload });
        closeModal();
        return;
      }
      if (act === "friend:decline"){
        socket.emit("friend:decline", { from: it.payload });
        closeModal();
        return;
      }

      if (act === "invite:accept"){
        socket.emit("groupInvite:accept", { id: it.payload.id });
        closeModal();
        return;
      }
      if (act === "invite:decline"){
        socket.emit("groupInvite:decline", { id: it.payload.id });
        closeModal();
        return;
      }
    });
  });
}

// -------------------- Menu / Settings / Logout --------------------
function openMenu(){
  if (!me) return;

  openModal("Account", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="row" id="menuProfile">
        <div class="rowLeft">
          ${icon("dm")}
          <div class="nameCol">
            <div class="rowName">Profile</div>
            <div class="rowSub">view profile + change status</div>
          </div>
        </div>
        ${icon("chev")}
      </div>

      <div class="row" id="menuSettings">
        <div class="rowLeft">
          ${icon("spark")}
          <div class="nameCol">
            <div class="rowName">Settings</div>
            <div class="rowSub">sounds, filters</div>
          </div>
        </div>
        ${icon("chev")}
      </div>

      <div class="row" id="menuLogout" style="border-color:rgba(255,82,82,.25)">
        <div class="rowLeft">
          ${icon("spark")}
          <div class="nameCol">
            <div class="rowName">Log out</div>
            <div class="rowSub">end session</div>
          </div>
        </div>
        ${icon("chev")}
      </div>

      ${isGuest ? `<div class="muted tiny">Guest mode: settings aren’t saved.</div>` : ``}
    </div>
  `);

  const p = $("menuProfile");
  const s = $("menuSettings");
  const l = $("menuLogout");

  if (p) p.onclick = ()=>{ closeModal(); openProfile(me); };
  if (s) s.onclick = ()=>{ closeModal(); openSettings(); };
  if (l) l.onclick = ()=>{ logout(); };
}

function openSettings(){
  const cur = settings || { sounds:true, hideMildProfanity:false };
  const draft = { sounds: cur.sounds !== false, hideMildProfanity: !!cur.hideMildProfanity };

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="row" style="cursor:default">
        <div class="rowLeft">
          ${icon("spark")}
          <div class="nameCol">
            <div class="rowName">Sounds</div>
            <div class="rowSub">ping on mentions/DM/group</div>
          </div>
        </div>
        <button class="btn small" id="soundToggle">${draft.sounds ? "On" : "Off"}</button>
      </div>

      <div class="row" style="cursor:default">
        <div class="rowLeft">
          ${icon("spark")}
          <div class="nameCol">
            <div class="rowName">Hide mild profanity</div>
            <div class="rowSub">mask common swears</div>
          </div>
        </div>
        <button class="btn small" id="filterToggle">${draft.hideMildProfanity ? "On" : "Off"}</button>
      </div>

      <div style="display:flex;justify-content:flex-end;gap:10px">
        <button class="btn primary" id="saveSettings">${icon("spark")}<span>Save</span></button>
      </div>

      <div class="muted tiny" style="line-height:1.45">
        Do Not Disturb disables notifications even if Sounds is On.
      </div>
    </div>
  `);

  const filterToggle = $("filterToggle");
  const soundToggle = $("soundToggle");
  const saveBtn = $("saveSettings");

  if (soundToggle) soundToggle.onclick = ()=>{
    draft.sounds = !draft.sounds;
    soundToggle.textContent = draft.sounds ? "On" : "Off";
  };
  if (filterToggle) filterToggle.onclick = ()=>{
    draft.hideMildProfanity = !draft.hideMildProfanity;
    filterToggle.textContent = draft.hideMildProfanity ? "On" : "Off";
  };

  if (saveBtn) saveBtn.onclick = ()=>{
    settings = { ...settings, ...draft };
    if (!isGuest) socket.emit("settings:update", settings);
    closeModal();
  };
}

function logout(){
  showLoading("logging out…");
  setTimeout(()=>{
    localStorage.removeItem("tonkotsu_token");
    location.reload();
  }, 360);
}

// -------------------- Profile (status dropdown lives here) --------------------
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
  const guestTarget = isGuestName(user);
  const st = friendState(user);

  const statusBlock = (!guestTarget && isSelf && !isGuest)
    ? `
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;font-size:12px;margin-bottom:8px">Status</div>
        <select class="field" id="statusSelect" style="height:36px">
          <option value="online">Online</option>
          <option value="idle">Idle</option>
          <option value="dnd">Do Not Disturb</option>
          <option value="invisible">Offline</option>
        </select>
        <div class="muted tiny" style="margin-top:8px;line-height:1.45">
          Idle auto-turns on after 3 minutes of inactivity when you are Online.
        </div>
      </div>
    `
    : ``;

  const actionBlock = (!guestTarget && !isSelf && !isGuest)
    ? `
      <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap">
        <button class="btn" id="profDM">${icon("dm")}<span>DM</span></button>

        ${
          st === "none" ? `<button class="btn primary" id="profAdd"><span>Add friend</span></button>` :
          st === "outgoing" ? `<button class="btn primary" disabled><span>Request sent</span></button>` :
          st === "incoming" ? `<button class="btn primary" id="profAccept"><span>Accept request</span></button>` :
          st === "friends" ? `<button class="btn primary" disabled><span>Friends</span></button>` :
          st === "blocked" ? `<button class="btn primary" id="profUnblock"><span>Unblock</span></button>` :
          `<button class="btn primary" id="profAdd"><span>Add friend</span></button>`
        }

        ${st !== "blocked" ? `<button class="btn" id="profBlock"><span>Block</span></button>` : ``}
      </div>
    `
    : ``;

  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="min-width:0">
        <div style="font-weight:950;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(user)}</div>
        <div class="muted tiny" id="profSub">${guestTarget ? "Guest user" : "loading…"}</div>
      </div>

      ${guestTarget ? "" : `
        <div style="border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02);padding:12px">
          <div style="font-weight:950;font-size:12px;margin-bottom:8px">Account</div>
          <div id="profStats" class="muted tiny" style="display:flex;flex-direction:column;gap:6px">loading…</div>
        </div>
      `}

      ${statusBlock}
      ${actionBlock}
    </div>
  `);

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
    if (addBtn && !addBtn.disabled) addBtn.onclick = ()=> socket.emit("friend:request", { to:user });

    const acceptBtn = $("profAccept");
    if (acceptBtn) acceptBtn.onclick = ()=>{ socket.emit("friend:accept", { from:user }); closeModal(); };

    const blkBtn = $("profBlock");
    if (blkBtn) blkBtn.onclick = ()=>{ socket.emit("user:block", { user }); closeModal(); };

    const unb = $("profUnblock");
    if (unb) unb.onclick = ()=>{ socket.emit("user:unblock", { user }); closeModal(); };
  }, 0);
}

// -------------------- Group info (click top title) --------------------
function openGroupInfo(groupId){
  const meta = groupMeta.get(groupId);
  if (!meta){
    openModal("Group", `<div class="muted">No group info available.</div>`);
    return;
  }

  const members = Array.isArray(meta.members) ? meta.members : [];
  const memberList = members.slice(0, 90).map(u=>`<div class="muted tiny" style="padding:2px 0">${escapeHtml(u)}</div>`).join("");
  const more = members.length > 90 ? `<div class="muted tiny">…and ${members.length - 90} more</div>` : ``;

  const ownerControls = (!isGuest && meta.owner === me)
    ? `
      <div style="border-top:1px solid rgba(255,255,255,.08);padding-top:12px;display:flex;flex-direction:column;gap:10px">
        <div style="font-weight:950">Owner tools</div>
        <div class="muted tiny">Hard cap: 200 members.</div>

        <div class="muted tiny">Add member (letters/numbers only)</div>
        <input class="field" id="addMemberName" placeholder="username" />
        <div style="display:flex;justify-content:flex-end">
          <button class="btn primary" id="addMemberBtn">${icon("spark")}<span>Add</span></button>
        </div>

        <div class="row" id="deleteGroupRow" style="border-color:rgba(255,82,82,.25)">
          <div class="rowLeft">
            ${icon("spark")}
            <div class="nameCol">
              <div class="rowName">Delete group</div>
              <div class="rowSub">owner only</div>
            </div>
          </div>
          ${icon("chev")}
        </div>
      </div>
    `
    : `
      <div style="border-top:1px solid rgba(255,255,255,.08);padding-top:12px">
        <div class="row" id="leaveGroupRow" style="border-color:rgba(255,82,82,.25)">
          <div class="rowLeft">
            ${icon("spark")}
            <div class="nameCol">
              <div class="rowName">Leave group</div>
              <div class="rowSub">remove yourself</div>
            </div>
          </div>
          ${icon("chev")}
        </div>
      </div>
    `;

  openModal("Group info", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;font-size:14px">${escapeHtml(meta.name)}</div>
        <div class="muted tiny" style="margin-top:6px">Owner: ${escapeHtml(meta.owner)}</div>
        <div class="muted tiny">Members: ${members.length} / 200</div>
        <div class="muted tiny">ID: ${escapeHtml(meta.id)}</div>
      </div>

      <div style="border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;margin-bottom:8px">Members</div>
        <div style="max-height:240px;overflow:auto">
          ${memberList || `<div class="muted tiny">No members found.</div>`}
          ${more}
        </div>
      </div>

      ${ownerControls}
    </div>
  `);

  const leaveRow = $("leaveGroupRow");
  if (leaveRow){
    leaveRow.onclick = ()=>{ socket.emit("group:leave", { groupId }); closeModal(); };
  }

  const delRow = $("deleteGroupRow");
  if (delRow){
    delRow.onclick = ()=>{
      openModal("Delete group", `
        <div class="muted" style="line-height:1.45">
          Are you sure you want to delete this group? This removes it for everyone.
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px; margin-top:12px">
          <button class="btn" id="gDelCancel"><span>Cancel</span></button>
          <button class="btn primary" id="gDelConfirm" style="border-color:rgba(255,82,82,.35)"><span>Delete</span></button>
        </div>
      `);
      const c = $("gDelCancel");
      const y = $("gDelConfirm");
      if (c) c.onclick = ()=>{ closeModal(); openGroupInfo(groupId); };
      if (y) y.onclick = ()=>{ socket.emit("group:delete", { groupId }); closeModal(); };
    };
  }

  const addBtn = $("addMemberBtn");
  if (addBtn){
    addBtn.onclick = ()=>{
      const name = ($("addMemberName")?.value || "").trim();
      if (!isValidUser(name)){
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
    toast("Guests", "Guests can’t create groups.");
    return;
  }

  openModal("Create group", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="muted">Group name</div>
      <input class="field" id="gcName" placeholder="Unnamed Group" />

      <div class="muted">Invite users (comma separated, up to 199)</div>
      <input class="field" id="gcInv" placeholder="user1, user2" />

      <div style="display:flex;justify-content:flex-end">
        <button class="btn primary" id="gcGo">${icon("spark")}<span>Send invites</span></button>
      </div>

      <div class="muted tiny" style="line-height:1.45">
        Group cap is 200 members. Owner + up to 199 invites.
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
      if (!isValidUser(u)){
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

  if (sendBtn){
    sendBtn.style.transform = "translateY(0) scale(.985)";
    setTimeout(()=>{ sendBtn.style.transform = ""; }, 120);
  }

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

// -------------------- Login UI --------------------
if (togglePass && passwordEl){
  togglePass.addEventListener("click", ()=>{
    const isPw = passwordEl.type === "password";
    passwordEl.type = isPw ? "text" : "password";
    togglePass.style.transform = "translateY(-50%) scale(0.98)";
    setTimeout(()=> togglePass.style.transform = "translateY(-50%)", 140);
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

    if (!isValidUser(u)){
      toast("Invalid username", "Use letters/numbers only (min 4).");
      return;
    }
    if (!isValidPass(p)){
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
    onlineToggle.style.transform = onlineWrap.classList.contains("collapsed") ? "rotate(-180deg)" : "rotate(0deg)";
    onlineToggle.style.transition = "transform 220ms cubic-bezier(.2,.85,.2,1)";
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
  if (loginCard){
    loginCard.classList.add("shake");
    setTimeout(()=> loginCard.classList.remove("shake"), 320);
  }
  toast("Login failed", msg || "Try again.");
});

socket.on("loginSuccess",(data)=>{
  showLoading("initializing…");

  me = data.username;
  isGuest = !!data.guest;

  settings = data.settings || settings;
  social = data.social || social;

  myStatus = data.status || "online";
  manualStatus = false;
  autoIdleEngaged = false;

  if (!isGuest && data.token){
    localStorage.setItem("tonkotsu_token", data.token);
    token = data.token;
  }

  if (cooldownLabel) cooldownLabel.textContent = `Cooldown: ${cooldownSeconds()}s`;

  if (mePill) mePill.style.display = "flex";
  if (meName) meName.textContent = me;
  if (meSub) meSub.textContent = isGuest ? "Guest" : "menu";

  applyMyStatusUI();

  // transition from login to app
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
  }, 260);
});

socket.on("settings",(s)=>{
  if (s) settings = s;
});

socket.on("social:update",(s)=>{
  if (s) social = s;
  updateBadges();
  renderMessagesList();
});

socket.on("status:update",({ status }={})=>{
  if (!status) return;
  myStatus = status;
  applyMyStatusUI();
});

socket.on("inbox:badge",(counts)=>{
  inboxCounts = counts || inboxCounts;
  unreadGlobalMentions = Number(inboxCounts?.ment || 0);
  updateBadges();
  renderMessagesList();
});

socket.on("inbox:data",(data)=>{
  const items = Array.isArray(data?.items) ? data.items : [];
  inboxMentionsCache = items.filter(x=>x.type==="mention");
  groupInvitesCache = items.filter(x=>x.type==="group").map(x=>({
    id: x.id,
    from: x.from,
    name: x.meta?.name || (x.text || "").match(/“(.+?)”/)?.[1] || "Group",
    ts: x.ts
  }));
  friendRequestsCache = items.filter(x=>x.type==="friend").map(x=>({ from: x.from, ts: x.ts }));

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

  // mention ping if not in global
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
    if (chatTitle){
      chatTitle.textContent = `Group — ${m.name}`;
      chatTitle.classList.add("clickable");
      chatTitle.onclick = ()=> openGroupInfo(groupId);
    }
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
      <div style="margin-top:10px">
        <div style="display:flex;justify-content:space-between;gap:10px">
          <div>XP</div><div>${xpNow}/${xpNext}</div>
        </div>
        <div style="margin-top:8px;height:10px;border-radius:999px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.10);overflow:hidden">
          <div style="height:100%;width:${Math.round(pct*100)}%;background:rgba(255,255,255,.18);transition:width 520ms cubic-bezier(.2,.85,.2,1)"></div>
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

// -------------------- Boot --------------------
function setInitialView(){
  setView("global");
  renderOnline();
  renderMessagesList();
  socket.emit("requestGlobalHistory");
}
setInitialView();
tryResume();
idleTick();

