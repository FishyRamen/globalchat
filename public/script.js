/* public/script.js
   Full client with:
   - Global chat + DMs + Groups
   - Inbox (mentions, invites, friend requests) from server
   - Discord-style pings/badges
   - Custom cursor modes
   - Block blur/unblur per message
   - @mentions highlight
   - Settings: cursor, reduce motion, sounds mute, privacy toggles
   - Status set (online/idle/dnd/invisible)
   - Country set + show/hide in profile
   - DM only if friended (enforced server-side too)
   - Public groups browsing + join
   - Delete account w/ confirmation + password
   - Guest restrictions (no DMs, no groups, no settings, no inbox)
*/

const socket = io();
const $ = (id) => document.getElementById(id);

// -------------------- DOM --------------------
const loginOverlay = $("loginOverlay");
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

const inboxBtn = $("inboxBtn");
const inboxPing = $("inboxPing");
const msgPing = $("msgPing");

const onlineCount = $("onlineCount");
const onlineList = $("onlineList");
const msgList = $("msgList");
const createGroupBtn = $("createGroupBtn");
const browseGroupsBtn = $("browseGroupsBtn");

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

let settings = null; // server settings: {cursorMode, reduceAnimations, sounds, density}
let prefs = null;    // privacy prefs: {allowFriendRequests, allowGroupInvites, showCountry}
let profile = null;  // my profile: {country}
let social = null;   // {friends,incoming,outgoing,blocked}

let view = { type: "global", id: null }; // global|dm|group
let currentDM = null;
let currentGroupId = null;

let onlineUsers = []; // [{user,status,guest}]
let globalCache = [];
let dmCache = new Map();     // other -> msgs (array)
let groupMeta = new Map();   // gid -> meta
let groupCache = new Map();  // gid -> msgs

let unreadDM = new Map();
let unreadGroup = new Map();

// Inbox items from server (flat list)
let inboxItems = []; // [{type,id,from,text,ts,groupId?,name?}]

// Public groups list
let publicGroups = []; // [{id,name,owner,membersCount,maxMembers,visibility}]

// Cooldown
let cooldownUntil = 0;

// Cursor local mode (mirrors server settings.cursorMode)
let cursorMode = "trail"; // off|dot|trail
let reduceAnims = false;
let mutedSounds = false;

// Per-message reveal for blocked content
const revealBlocked = new Set(); // key strings

// -------------------- Helpers --------------------
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
function toast(title, msg){
  if (!toasts) return;
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
function showLoading(text="syncing…"){
  if (loaderSub) loaderSub.textContent = text;
  if (loading) loading.classList.add("show");
}
function hideLoading(){
  if (loading) loading.classList.remove("show");
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
function isGuestName(name){ return /^Guest\d{4,5}$/.test(String(name||"")); }
function dmAllowedWith(user){
  if (isGuest) return false;
  const friends = Array.isArray(social?.friends) ? social.friends : [];
  return friends.includes(user);
}
function isBlockedUser(u){
  const b = Array.isArray(social?.blocked) ? social.blocked : [];
  return b.includes(u);
}
function msgKey(scope, user, ts, text){
  // stable enough for local reveal toggles
  const base = `${scope}|${user||""}|${Number(ts)||0}|${String(text||"").slice(0,80)}`;
  let h = 0;
  for (let i=0;i<base.length;i++) h = ((h<<5)-h) + base.charCodeAt(i) | 0;
  return String(h);
}

// -------------------- Cursor (3 modes) --------------------
let mouseX = window.innerWidth/2, mouseY = window.innerHeight/2;
let dotX = mouseX, dotY = mouseY, ringX = mouseX, ringY = mouseY;
const trail = [];
const TRAIL_MAX = 10;

function setCursorMode(mode){
  cursorMode = mode; // off|dot|trail
  const off = (mode === "off");
  document.body.style.cursor = off ? "auto" : "none";

  // Ensure elements don’t show default cursor
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

// -------------------- Rendering --------------------
function setView(type, id=null){
  view = { type, id };
  currentDM = (type==="dm") ? id : null;
  currentGroupId = (type==="group") ? id : null;

  if (!chatTitle || !chatHint) return;

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
  }
}
function clearChat(){
  if (chatBox) chatBox.innerHTML = "";
}
function renderTextWithMentions(text){
  if (!me) return escapeHtml(text);
  const safe = escapeHtml(text);
  const rx = new RegExp(`(@${me.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`, "ig");
  return safe.replace(rx, `<span style="color:var(--warn);font-weight:950">$1</span>`);
}

function addMessageToUI({ user, text, ts }, scope){
  if (!chatBox) return;

  const time = fmtTime(ts);
  const who = String(user || "—");
  let bodyText = String(text ?? "");
  const blocked = isBlockedUser(who) && who !== me;

  const isHidden = (bodyText === "__HIDDEN_BY_FILTER__");
  if (isHidden) bodyText = "Message hidden (filtered).";

  const key = msgKey(scope, who, ts, bodyText);
  const revealed = revealBlocked.has(key);

  const row = document.createElement("div");
  row.className = "msg";

  const rendered = renderTextWithMentions(bodyText);

  if (blocked && !revealed){
    row.innerHTML = `
      <div class="bubble">
        <div class="meta">
          <div class="u" data-user="${escapeHtml(who)}">${escapeHtml(who)}</div>
          <div class="t">${escapeHtml(time)}</div>
        </div>

        <div class="blockedWrap">
          <div class="blockedBar">
            <div class="blockedText">Blocked user • message blurred</div>
            <button class="btn small" data-reveal="1">Show</button>
          </div>
          <div class="body blockedBody">${rendered}</div>
        </div>
      </div>
    `;
  } else {
    row.innerHTML = `
      <div class="bubble">
        <div class="meta">
          <div class="u" data-user="${escapeHtml(who)}">${escapeHtml(who)}${(who===me?" (You)":"")}</div>
          <div class="t">${escapeHtml(time)}</div>
        </div>
        <div class="body">${rendered}</div>
      </div>
    `;
  }

  const uEl = row.querySelector(".u");
  if (uEl){
    uEl.addEventListener("click", ()=>{
      const u = uEl.getAttribute("data-user");
      openProfile(u);
    });
  }

  const revealBtn = row.querySelector('[data-reveal="1"]');
  if (revealBtn){
    revealBtn.addEventListener("click", ()=>{
      revealBlocked.add(key);
      // re-render this message as revealed
      row.remove();
      addMessageToUI({ user: who, text, ts }, scope);
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
    const stTxt = (st === "dnd") ? "Do not disturb" : (st === "idle") ? "Idle" : (st === "invisible") ? "Offline" : "Online";
    return `
      <div class="row" data-open-profile="${escapeHtml(name)}">
        <div class="rowLeft">
          <div class="statusDot ${st !== "invisible" ? "on" : ""}"></div>
          <div class="nameCol">
            <div class="rowName">${escapeHtml(name)}${name===me?" (You)":""}</div>
            <div class="rowSub">${escapeHtml(stTxt)}</div>
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
  const m = totalMessagePings();
  if (msgPing){
    msgPing.textContent = String(m);
    msgPing.classList.toggle("show", m > 0);
  }
}

function renderMessagesList(){
  if (!msgList) return;

  // Only show DM threads for friends (since you can only DM friends)
  const dmUsers = Array.from(dmCache.keys())
    .filter(u => dmAllowedWith(u))
    .sort((a,b)=>a.localeCompare(b));

  const groups = Array.from(groupMeta.values())
    .sort((a,b)=>String(a.name).localeCompare(String(b.name)));

  msgList.innerHTML = `
    <div class="row" data-open="global">
      <div class="rowLeft">
        <div class="statusDot on"></div>
        <div class="nameCol">
          <div class="rowName">Global chat</div>
          <div class="rowSub">shared</div>
        </div>
      </div>
    </div>

    ${dmUsers.map(u=>{
      const c = unreadDM.get(u) || 0;
      const on = onlineUsers.some(x=>x.user===u && x.status !== "invisible");
      return `
        <div class="row" data-open="dm" data-id="${escapeHtml(u)}">
          <div class="rowLeft">
            <div class="statusDot ${on?"on":""}"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u)}</div>
              <div class="rowSub">dm (friends)</div>
            </div>
          </div>
          <div class="badge ${c>0?"show":""}" style="display:${c>0?"flex":"none"}">${c}</div>
        </div>
      `;
    }).join("")}

    ${groups.map(g=>{
      const c = unreadGroup.get(g.id) || 0;
      const youAreOwner = (g.owner === me);
      return `
        <div class="row" data-open="group" data-id="${escapeHtml(g.id)}">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(g.name)}${youAreOwner?" (Owner)":""}</div>
              <div class="rowSub">${escapeHtml(g.id)}</div>
            </div>
          </div>
          <div class="badge ${c>0?"show":""}" style="display:${c>0?"flex":"none"}">${c}</div>
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

  updateBadges();
}

// -------------------- Openers --------------------
function openGlobal(){
  setView("global");
  clearChat();
  globalCache.forEach(m=> addMessageToUI(m, "global"));
  socket.emit("requestGlobalHistory");
}

function openDM(user){
  if (isGuest){
    toast("Guests", "Guests can’t use DMs. Log in to DM.");
    return;
  }
  if (!user) return;
  if (!dmAllowedWith(user)){
    toast("DMs", "You can only DM friends.");
    return;
  }

  unreadDM.set(user, 0);
  updateBadges();

  setView("dm", user);
  clearChat();
  socket.emit("dm:history", { withUser: user });
}

function openGroup(gid){
  if (isGuest){
    toast("Guests", "Guests can’t use groups.");
    return;
  }
  if (!gid) return;

  unreadGroup.set(gid, 0);
  updateBadges();

  setView("group", gid);
  clearChat();
  socket.emit("group:history", { groupId: gid });
}

// -------------------- Inbox --------------------
function openInbox(){
  if (isGuest){
    openModal("Inbox", `<div class="muted">Guest mode has no inbox.</div>`);
    return;
  }

  socket.emit("inbox:get");

  const items = Array.isArray(inboxItems) ? inboxItems.slice() : [];
  items.sort((a,b)=> (b.ts||0) - (a.ts||0));

  const html = `
    <div style="display:flex;flex-direction:column;gap:10px">
      ${items.length ? items.map((it, idx)=>`
        <div class="row">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(it.text || "Inbox item")}</div>
              <div class="rowSub">${escapeHtml(new Date(it.ts||Date.now()).toLocaleString())}</div>
            </div>
          </div>
          <button class="btn small primary" data-inbox-open="${idx}">Open</button>
        </div>
      `).join("") : `<div class="muted">Nothing here right now.</div>`}
      ${items.some(x=>x.type==="mention") ? `
        <div style="display:flex;justify-content:flex-end;margin-top:4px">
          <button class="btn small" id="clearMentions">Clear mentions</button>
        </div>
      `: ``}
    </div>
  `;

  openModal("Inbox", html);

  const clearBtn = $("clearMentions");
  if (clearBtn) clearBtn.onclick = ()=>{
    socket.emit("inbox:clearMentions");
    toast("Inbox", "Mentions cleared.");
    // server will refresh counts; client will refresh items after next inbox:get
    closeModal();
  };

  modalBody.querySelectorAll("[data-inbox-open]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const idx = Number(btn.getAttribute("data-inbox-open"));
      const it = items[idx];
      if (!it) return;

      if (it.type === "mention"){
        closeModal();
        openGlobal();
        toast("Mention", "Opened Global chat.");
        return;
      }

      if (it.type === "group"){
        socket.emit("groupInvite:accept", { id: it.groupId || it.id });
        toast("Group", "Invite accepted.");
        closeModal();
        return;
      }

      if (it.type === "friend"){
        socket.emit("friend:accept", { from: it.from });
        toast("Friends", `Accepted ${it.from}.`);
        closeModal();
        return;
      }
    });
  });
}

// -------------------- Account Menu + Settings --------------------
function openMenu(){
  if (!me) return;

  const isReal = !isGuest;

  const status = (onlineUsers.find(x=>x.user===me)?.status) || "online";
  const statusText = (status==="dnd")?"Do not disturb":(status==="idle")?"Idle":(status==="invisible")?"Offline":"Online";

  openModal("Account", `
    <div style="display:flex;flex-direction:column;gap:10px">

      <div class="row" id="menuProfile">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Profile</div>
            <div class="rowSub">view your profile</div>
          </div>
        </div>
      </div>

      <div class="row" id="menuStatus">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Status</div>
            <div class="rowSub">${escapeHtml(statusText)} • change status</div>
          </div>
        </div>
      </div>

      <div class="row" id="menuSettings">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Settings</div>
            <div class="rowSub">cursor, privacy, mute, delete</div>
          </div>
        </div>
      </div>

      ${isReal ? `
        <div class="row" id="menuLogout" style="border-color:rgba(255,82,82,.35)">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">Log out</div>
              <div class="rowSub">end session</div>
            </div>
          </div>
        </div>
      ` : `
        <div class="row" id="menuLogin" style="border-color:rgba(255,255,255,.18)">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">Log in</div>
              <div class="rowSub">exit guest mode</div>
            </div>
          </div>
        </div>
        <div class="muted">Guest mode has no inbox, settings, DMs, or groups.</div>
      `}
    </div>
  `);

  const p = $("menuProfile");
  const st = $("menuStatus");
  const s = $("menuSettings");
  const l = $("menuLogout");
  const li = $("menuLogin");

  if (p) p.onclick = ()=>{ closeModal(); openProfile(me); };
  if (st) st.onclick = ()=>{ closeModal(); openStatusPicker(); };
  if (s) s.onclick = ()=>{ closeModal(); openSettings(); };
  if (l) l.onclick = ()=>{ logout(); };
  if (li) li.onclick = ()=>{ logout(true); };
}

function openStatusPicker(){
  if (!me) return;
  const cur = (onlineUsers.find(x=>x.user===me)?.status) || "online";

  openModal("Status", `
    <div style="display:flex;flex-direction:column;gap:10px">
      ${["online","idle","dnd","invisible"].map(st=>`
        <div class="row" data-st="${st}">
          <div class="rowLeft">
            <div class="statusDot ${st!=="invisible"?"on":""}"></div>
            <div class="nameCol">
              <div class="rowName">${st === "dnd" ? "Do not disturb" : st === "idle" ? "Idle" : st === "invisible" ? "Offline" : "Online"}${st===cur?" (Current)":""}</div>
              <div class="rowSub">${st==="invisible"?"Hide from online list":"Visible"}</div>
            </div>
          </div>
        </div>
      `).join("")}
    </div>
  `);

  modalBody.querySelectorAll("[data-st]").forEach(el=>{
    el.addEventListener("click", ()=>{
      const st = el.getAttribute("data-st");
      socket.emit("status:set", { status: st });
      toast("Status", "Updated.");
      closeModal();
    });
  });
}

function openSettings(){
  if (isGuest){
    openModal("Settings", `<div class="muted">Guest mode has no settings.</div>`);
    return;
  }

  const s = settings || { cursorMode:"trail", reduceAnimations:false, sounds:true, density:0.12 };
  const p = prefs || { allowFriendRequests:true, allowGroupInvites:true, showCountry:true };
  const myCountry = profile?.country || "";

  const draft = {
    cursorMode: s.cursorMode || "trail",
    reduceAnimations: !!s.reduceAnimations,
    sounds: s.sounds !== false,
    allowFriendRequests: p.allowFriendRequests !== false,
    allowGroupInvites: p.allowGroupInvites !== false,
    showCountry: p.showCountry !== false,
    country: myCountry
  };

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:12px">

      <div class="row" id="setCursor">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Cursor mode</div>
            <div class="rowSub">Off / Dot / Dot + trail</div>
          </div>
        </div>
        <button class="btn small" id="cursorCycle">${escapeHtml(draft.cursorMode)}</button>
      </div>

      <div class="row" id="setReduce">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Reduce animations</div>
            <div class="rowSub">less motion</div>
          </div>
        </div>
        <button class="btn small" id="reduceToggle">${draft.reduceAnimations ? "On" : "Off"}</button>
      </div>

      <div class="row" id="setSounds">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Mute sounds</div>
            <div class="rowSub">notifications + UI sounds</div>
          </div>
        </div>
        <button class="btn small" id="soundsToggle">${draft.sounds ? "Off" : "On"}</button>
      </div>

      <div class="row" id="setFriendReq">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Allow friend requests</div>
            <div class="rowSub">others can add you</div>
          </div>
        </div>
        <button class="btn small" id="friendToggle">${draft.allowFriendRequests ? "On" : "Off"}</button>
      </div>

      <div class="row" id="setGroupInv">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Allow group invites</div>
            <div class="rowSub">others can invite you</div>
          </div>
        </div>
        <button class="btn small" id="groupToggle">${draft.allowGroupInvites ? "On" : "Off"}</button>
      </div>

      <div style="border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;font-size:12px;margin-bottom:8px">Profile</div>

        <div class="muted" style="margin-bottom:6px">Country (optional)</div>
        <input class="field" id="countryInput" placeholder="Canada" value="${escapeHtml(draft.country)}" />

        <div style="height:10px"></div>

        <div class="row" id="setShowCountry">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">Show country on profile</div>
              <div class="rowSub">others can see it</div>
            </div>
          </div>
          <button class="btn small" id="countryToggle">${draft.showCountry ? "On" : "Off"}</button>
        </div>
      </div>

      <div class="row" id="deleteAccountRow" style="border-color:rgba(255,82,82,.35)">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">Delete account</div>
            <div class="rowSub">permanent</div>
          </div>
        </div>
        <button class="btn small danger" id="deleteAccountBtn">Delete</button>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn primary" id="saveSettings">Save</button>
        <button class="btn" id="closeSettings">Close</button>
      </div>
    </div>
  `);

  const cursorCycle = $("cursorCycle");
  const reduceToggle = $("reduceToggle");
  const soundsToggle = $("soundsToggle");
  const friendToggle = $("friendToggle");
  const groupToggle = $("groupToggle");
  const countryToggle = $("countryToggle");
  const countryInput = $("countryInput");
  const saveBtn = $("saveSettings");
  const closeBtn = $("closeSettings");
  const deleteBtn = $("deleteAccountBtn");

  function refreshButtons(){
    if (cursorCycle) cursorCycle.textContent = draft.cursorMode;
    if (reduceToggle) reduceToggle.textContent = draft.reduceAnimations ? "On" : "Off";
    if (soundsToggle) soundsToggle.textContent = draft.sounds ? "Off" : "On"; // button says "Mute sounds": Off means not muted
    if (friendToggle) friendToggle.textContent = draft.allowFriendRequests ? "On" : "Off";
    if (groupToggle) groupToggle.textContent = draft.allowGroupInvites ? "On" : "Off";
    if (countryToggle) countryToggle.textContent = draft.showCountry ? "On" : "Off";
  }

  if (cursorCycle) cursorCycle.onclick = ()=>{
    const order = ["off","dot","trail"];
    const i = Math.max(0, order.indexOf(draft.cursorMode));
    draft.cursorMode = order[(i+1)%order.length];
    setCursorMode(draft.cursorMode);
    refreshButtons();
    toast("Cursor", `Mode: ${draft.cursorMode}`);
  };

  if (reduceToggle) reduceToggle.onclick = ()=>{
    draft.reduceAnimations = !draft.reduceAnimations;
    reduceAnims = draft.reduceAnimations;
    refreshButtons();
  };

  if (soundsToggle) soundsToggle.onclick = ()=>{
    draft.sounds = !draft.sounds;
    mutedSounds = !draft.sounds;
    refreshButtons();
  };

  if (friendToggle) friendToggle.onclick = ()=>{
    draft.allowFriendRequests = !draft.allowFriendRequests;
    refreshButtons();
  };

  if (groupToggle) groupToggle.onclick = ()=>{
    draft.allowGroupInvites = !draft.allowGroupInvites;
    refreshButtons();
  };

  if (countryToggle) countryToggle.onclick = ()=>{
    draft.showCountry = !draft.showCountry;
    refreshButtons();
  };

  if (closeBtn) closeBtn.onclick = ()=>{
    // revert to saved settings
    applyLocalSettingsFromServer();
    closeModal();
  };

  if (saveBtn) saveBtn.onclick = ()=>{
    const newCountry = String(countryInput?.value || "").trim().slice(0, 40);
    draft.country = newCountry;

    // persist to server
    socket.emit("settings:update", {
      cursorMode: draft.cursorMode,
      reduceAnimations: draft.reduceAnimations,
      sounds: draft.sounds,
      density: Number.isFinite(settings?.density) ? settings.density : 0.12
    });

    socket.emit("prefs:update", {
      allowFriendRequests: draft.allowFriendRequests,
      allowGroupInvites: draft.allowGroupInvites,
      showCountry: draft.showCountry
    });

    socket.emit("profile:update", { country: draft.country });

    toast("Settings", "Saved");
    closeModal();
  };

  if (deleteBtn) deleteBtn.onclick = ()=>{
    openDeleteAccountConfirm();
  };
}

function openDeleteAccountConfirm(){
  openModal("Delete account", `
    <div style="display:flex;flex-direction:column;gap:12px">
      <div class="muted" style="line-height:1.45">
        This permanently deletes your account. Your messages may remain in chats, but your account, sessions, and social data are removed.
      </div>

      <div class="muted">Type <b style="color:var(--text)">DELETE</b> to confirm</div>
      <input class="field" id="delType" placeholder="DELETE" />

      <div class="muted">Enter your password</div>
      <input class="field" id="delPass" type="password" placeholder="••••" />

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn danger" id="delGo">Delete</button>
        <button class="btn" id="delCancel">Cancel</button>
      </div>
    </div>
  `);

  const delGo = $("delGo");
  const delCancel = $("delCancel");
  if (delCancel) delCancel.onclick = closeModal;

  if (delGo) delGo.onclick = ()=>{
    const t = String($("delType")?.value || "").trim();
    const p = String($("delPass")?.value || "");
    if (t !== "DELETE"){
      toast("Delete", "Type DELETE to confirm.");
      return;
    }
    if (!p){
      toast("Delete", "Password required.");
      return;
    }
    showLoading("deleting account…");
    socket.emit("account:delete", { password: p });
  };
}

function logout(toLogin=false){
  showLoading(toLogin ? "leaving guest…" : "logging out…");
  setTimeout(()=>{
    localStorage.removeItem("tonkotsu_token");
    location.reload();
  }, reduceAnims ? 160 : 360);
}

function applyLocalSettingsFromServer(){
  const s = settings || { cursorMode:"trail", reduceAnimations:false, sounds:true };
  reduceAnims = !!s.reduceAnimations;
  mutedSounds = (s.sounds === false);
  setCursorMode(s.cursorMode || "trail");
}

// -------------------- Profile --------------------
function openProfile(user){
  if (!user) return;

  const guest = isGuestName(user);

  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:950;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(user)}</div>
          <div class="muted" id="profSub">${guest ? "Guest user" : "loading…"}</div>
        </div>
        <button class="btn small" id="profClose">Close</button>
      </div>

      <div id="profCountryBox" style="display:none;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
        <div style="font-weight:950;font-size:12px;margin-bottom:8px">Country</div>
        <div class="muted" id="profCountryVal">—</div>
      </div>

      ${guest ? "" : `
        <div style="border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);padding:12px">
          <div style="font-weight:950;font-size:12px;margin-bottom:8px">Account</div>
          <div id="profStats" class="muted" style="display:flex;flex-direction:column;gap:6px">loading…</div>
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${user !== me && !isGuest ? `<button class="btn" id="profDM">DM</button>` : ``}
          ${user !== me && !isGuest ? `<button class="btn" id="profAdd">Add friend</button>` : ``}
          ${user !== me && !isGuest ? `<button class="btn" id="profBlock">Block</button>` : ``}
          ${user !== me && !isGuest ? `<button class="btn" id="profUnblock" style="display:none">Unblock</button>` : ``}
        </div>
      `}
    </div>
  `);

  const pc = $("profClose");
  if (pc) pc.onclick = closeModal;

  if (!guest){
    modalBody._profileUser = user;
    socket.emit("profile:get", { user });

    setTimeout(()=>{
      const dmBtn = $("profDM");
      const addBtn = $("profAdd");
      const blkBtn = $("profBlock");
      const unblkBtn = $("profUnblock");

      const blocked = isBlockedUser(user);
      if (blkBtn) blkBtn.style.display = blocked ? "none" : "inline-block";
      if (unblkBtn) unblkBtn.style.display = blocked ? "inline-block" : "none";

      if (dmBtn) dmBtn.onclick = ()=>{
        if (!dmAllowedWith(user)){
          toast("DMs", "You can only DM friends.");
          return;
        }
        closeModal();
        openDM(user);
      };

      if (addBtn) addBtn.onclick = ()=>{
        socket.emit("friend:request", { to:user });
        toast("Friends","Request sent (if allowed).");
      };

      if (blkBtn) blkBtn.onclick = ()=>{
        socket.emit("user:block", { user });
        toast("Blocked", `${user} blocked.`);
        closeModal();
      };

      if (unblkBtn) unblkBtn.onclick = ()=>{
        socket.emit("user:unblock", { user });
        toast("Blocked", `${user} unblocked.`);
        closeModal();
      };
    }, 0);
  }
}

// -------------------- Group creation + browsing --------------------
function openCreateGroup(){
  if (isGuest){
    toast("Guests","Guests can’t create groups.");
    return;
  }

  openModal("Create group", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div class="muted">Group name</div>
      <input class="field" id="gcName" placeholder="Unnamed Group" />

      <div class="muted">Visibility</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn small primary" id="gcVisPublic">Public</button>
        <button class="btn small" id="gcVisPrivate">Private</button>
      </div>
      <div class="muted" id="gcVisHint">Public groups can be browsed and joined.</div>

      <div class="muted">Member limit (2 - 200)</div>
      <input class="field" id="gcLimit" placeholder="50" />

      <div class="muted">Invite users (comma separated) — required for private groups</div>
      <input class="field" id="gcInv" placeholder="user1, user2" />

      <button class="btn primary" id="gcGo">Create</button>
      <div class="muted" style="line-height:1.45">
        Private groups activate after someone accepts an invite. Public groups activate immediately.
      </div>
    </div>
  `);

  let visibility = "public";
  const pub = $("gcVisPublic");
  const pri = $("gcVisPrivate");
  const hint = $("gcVisHint");

  function setVis(v){
    visibility = v;
    if (pub) pub.classList.toggle("primary", v==="public");
    if (pri) pri.classList.toggle("primary", v==="private");
    if (hint) hint.textContent = v==="public"
      ? "Public groups can be browsed and joined."
      : "Private groups require invites.";
  }
  setVis("public");

  if (pub) pub.onclick = ()=>setVis("public");
  if (pri) pri.onclick = ()=>setVis("private");

  const go = $("gcGo");
  if (go) go.onclick = ()=>{
    const name = ($("gcName")?.value || "").trim();
    const invitesRaw = ($("gcInv")?.value || "").trim();
    const invites = invitesRaw.split(",").map(s=>s.trim()).filter(Boolean);
    const limit = Number(($("gcLimit")?.value || "").trim() || "50");

    closeModal();
    socket.emit("group:create", { name, invites, visibility, maxMembers: limit });
    toast("Group","Creating…");
  };
}

function openBrowseGroups(){
  if (isGuest){
    toast("Guests","Guests can’t browse groups.");
    return;
  }

  socket.emit("groups:publicList");

  const html = `
    <div class="muted" style="margin-bottom:10px">Public groups you can join:</div>
    <div id="pubGroupsWrap" style="display:flex;flex-direction:column;gap:10px"></div>
  `;
  openModal("Browse groups", html);
  renderPublicGroupsIntoModal();
}

function renderPublicGroupsIntoModal(){
  const wrap = $("pubGroupsWrap");
  if (!wrap) return;

  const list = Array.isArray(publicGroups) ? publicGroups : [];
  if (!list.length){
    wrap.innerHTML = `<div class="muted">No public groups yet.</div>`;
    return;
  }

  wrap.innerHTML = list.map(g=>{
    const inIt = groupMeta.has(g.id);
    const full = (g.membersCount >= g.maxMembers);
    return `
      <div class="row">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">${escapeHtml(g.name)}</div>
            <div class="rowSub">Owner: ${escapeHtml(g.owner)} • ${g.membersCount}/${g.maxMembers}</div>
          </div>
        </div>
        <button class="btn small ${inIt ? "" : "primary"}" data-join="${escapeHtml(g.id)}" ${inIt || full ? "disabled" : ""}>
          ${inIt ? "Joined" : full ? "Full" : "Join"}
        </button>
      </div>
    `;
  }).join("");

  wrap.querySelectorAll("[data-join]").forEach(btn=>{
    btn.addEventListener("click", ()=>{
      const gid = btn.getAttribute("data-join");
      socket.emit("group:joinPublic", { groupId: gid });
      btn.textContent = "Joining…";
      btn.disabled = true;
    });
  });
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
    if (!u || !p){
      $("loginCard")?.classList.add("shake");
      setTimeout(()=> $("loginCard")?.classList.remove("shake"), 350);
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
if (browseGroupsBtn) browseGroupsBtn.addEventListener("click", openBrowseGroups);
if (mePill) mePill.addEventListener("click", openMenu);

// -------------------- Socket events --------------------
socket.on("resumeFail", ()=>{
  localStorage.removeItem("tonkotsu_token");
  token = null;
  hideLoading();
});

socket.on("loginError",(msg)=>{
  hideLoading();
  $("loginCard")?.classList.add("shake");
  setTimeout(()=> $("loginCard")?.classList.remove("shake"), 350);
  toast("Login failed", msg || "Try again.");
});

socket.on("sendError", (e)=>{
  if (!e) return;
  toast("Error", e.reason || "Action failed.");
});

socket.on("loginSuccess",(data)=>{
  hideLoading();

  me = data.username;
  isGuest = !!data.guest;

  settings = data.settings || settings || { cursorMode:"trail", reduceAnimations:false, sounds:true, density:0.12 };
  prefs = data.prefs || prefs || { allowFriendRequests:true, allowGroupInvites:true, showCountry:true };
  profile = data.profile || profile || { country:"" };
  social = data.social || social || { friends:[], incoming:[], outgoing:[], blocked:[] };

  if (!isGuest && data.token){
    localStorage.setItem("tonkotsu_token", data.token);
    token = data.token;
  }

  // show app
  if (loginOverlay) loginOverlay.classList.add("hidden");
  if (mePill) mePill.style.display = "flex";
  if (meName) meName.textContent = me;
  if (meSub) meSub.textContent = isGuest ? "Guest" : "click for menu";

  applyLocalSettingsFromServer();

  if (cooldownLabel) cooldownLabel.textContent = `Cooldown: ${cooldownSeconds()}s`;
  if (statusLabel) statusLabel.textContent = `Status: ${(data.status || "online") === "dnd" ? "Do not disturb" : (data.status || "online")}`;

  toast("Welcome", isGuest ? "Joined as guest" : `Logged in as ${me}`);

  openGlobal();
  socket.emit("requestGlobalHistory");

  if (!isGuest){
    socket.emit("social:sync");
    socket.emit("groups:list");
    socket.emit("inbox:get");
    socket.emit("prefs:get");
    socket.emit("profile:get", { user: me });
  }

  renderMessagesList();
});

socket.on("settings",(s)=>{
  settings = s || settings;
  applyLocalSettingsFromServer();
});

socket.on("prefs:data",(p)=>{
  prefs = p || prefs;
});

socket.on("social:update",(s)=>{
  social = s || social;
  renderMessagesList();
});

socket.on("status:update", ({ status }={})=>{
  const st = status || "online";
  if (statusLabel){
    const txt = st==="dnd" ? "Do not disturb" : st==="idle" ? "Idle" : st==="invisible" ? "Offline" : "Online";
    statusLabel.textContent = `Status: ${txt}`;
  }
});

socket.on("inbox:badge",(b)=>{
  const total_toggle = Number(b?.total || 0);
  if (inboxPing){
    inboxPing.textContent = String(total_toggle);
    inboxPing.classList.toggle("show", total_toggle > 0);
  }
});

socket.on("inbox:data",(data)=>{
  inboxItems = Array.isArray(data?.items) ? data.items : [];
});

socket.on("onlineUsers",(list)=>{
  onlineUsers = Array.isArray(list) ? list : [];
  renderOnline();
  renderMessagesList();
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
  if (globalCache.length > 350) globalCache.shift();
  if (view.type === "global") addMessageToUI(msg,"global");
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

  // keep thread only for friends
  if (!dmAllowedWith(from)) return;

  if (!dmCache.has(from)) dmCache.set(from, []);
  dmCache.get(from).push(msg);
  if (dmCache.get(from).length > 300) dmCache.get(from).shift();

  if (!(view.type==="dm" && currentDM===from)){
    unreadDM.set(from, (unreadDM.get(from)||0) + 1);
    updateBadges();
  } else {
    addMessageToUI({user: msg.user, text: msg.text, ts: msg.ts},"dm");
  }
  renderMessagesList();
});

socket.on("groups:list",(list)=>{
  groupMeta.clear();
  (Array.isArray(list)?list:[]).forEach(g=>{
    groupMeta.set(g.id, {
      id:g.id,
      name:g.name,
      owner:g.owner,
      members:g.members||[],
      maxMembers: g.maxMembers || 50,
      visibility: g.visibility || "private"
    });
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
  if (groupCache.get(groupId).length > 380) groupCache.get(groupId).shift();

  if (!(view.type==="group" && currentGroupId===groupId)){
    unreadGroup.set(groupId, (unreadGroup.get(groupId)||0) + 1);
    updateBadges();
  } else {
    addMessageToUI(msg,"group");
  }
  renderMessagesList();
});

socket.on("group:meta",({ groupId, meta }={})=>{
  if (!groupId || !meta) return;
  groupMeta.set(groupId, meta);
  if (view.type==="group" && currentGroupId===groupId){
    chatTitle.textContent = `Group — ${meta.name || "Group"}`;
  }
  renderMessagesList();
});

socket.on("group:left",({ groupId }={})=>{
  toast("Group","Left group.");
  unreadGroup.delete(groupId);
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  updateBadges();
  openGlobal();
  socket.emit("groups:list");
});

socket.on("group:deleted",({ groupId }={})=>{
  toast("Group","Group deleted.");
  unreadGroup.delete(groupId);
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  updateBadges();
  openGlobal();
  socket.emit("groups:list");
});

socket.on("groups:publicList",(data)=>{
  publicGroups = Array.isArray(data?.groups) ? data.groups : [];
  renderPublicGroupsIntoModal();
});

socket.on("account:deleted", ()=>{
  // server confirmed deletion
  localStorage.removeItem("tonkotsu_token");
  showLoading("account deleted…");
  setTimeout(()=> location.reload(), reduceAnims ? 200 : 450);
});

// -------------------- Init --------------------
setCursorMode("trail");
requestAnimationFrame(cursorTick);
tryResume();

// Default UI state
setView("global");
renderOnline();
renderMessagesList();

