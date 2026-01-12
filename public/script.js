const socket = io();
const $ = (id) => document.getElementById(id);

const app = $("app");
const loginScreen = $("loginScreen");
const loginHint = $("loginHint");
const loadingOverlay = $("loadingOverlay");

const meName = $("meName");
const mePill = $("mePill");

const inboxBtn = $("inboxBtn");
const inboxBadge = $("inboxBadge");

const messagesList = $("messagesList");
const onlineList = $("onlineList");

const chatTitle = $("chatTitle");
const chatSub = $("chatSub");
const chatBody = $("chatBody");
const composer = $("composer");
const msgInput = $("msgInput");
const sendBtn = $("sendBtn");

const cooldownBox = $("cooldownBox");
const cooldownText = $("cooldownText");

const userInput = $("userInput");
const passInput = $("passInput");
const loginBtn = $("loginBtn");
const guestBtn = $("guestBtn");
const eyeBtn = $("eyeBtn");

const modalOverlay = $("modalOverlay");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
const modalFooter = $("modalFooter");
const modalClose = $("modalClose");

const toasts = $("toasts");

const cursorDot = $("cursorDot");
const cursorTrail = $("cursorTrail");

// ---- state
let me = { username: "Guest0000", guest: true, token: null, tutorialDone: true, isNew: false };
let settings = {
  density: 0.10,
  sidebar: 0.22,
  cursorMode: "trail",
  sounds: true,
  pingVolume: 0.65,
  reduceAnimations: false
};

let social = { friends: [], incoming: [], outgoing: [], blocked: [] };
let myGroups = [];
let leaderboard = [];
let bio = "";

let view = { kind: "global", target: null }; // global | dm | gc | leaderboard
let inboxCount = 0;

let globalCooldownUntil = 0;
let cooldownTimer = null;

let cursorMode = "trail";
let cx=0, cy=0, tx=0, ty=0, cursorRAF=null;

// Tutorial
let tutorialActive = false;
const TUTORIAL_BOT = "TutorialBot";

// ---- helpers
function clamp01(n){ return Math.max(0, Math.min(1, n)); }
function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtTime(ts){
  try{
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }catch{ return ""; }
}
function isGuest(name){ return /^Guest\d{4,5}$/.test(String(name)); }

function saveToken(t){
  try{
    if (t) localStorage.setItem("tonkotsu_token", t);
    else localStorage.removeItem("tonkotsu_token");
  }catch{}
}
function loadToken(){
  try{ return localStorage.getItem("tonkotsu_token"); }catch{ return null; }
}

// ---- animations reduce
function applyReduceAnimations(){
  document.body.classList.toggle("reduce", !!settings.reduceAnimations);
}

// ---- cursor
function setCursorMode(mode){
  cursorMode = (mode === "off" || mode === "dot" || mode === "trail") ? mode : "trail";
  const on = cursorMode !== "off";
  document.body.classList.toggle("cursorOn", on);

  cursorDot.style.display = on ? "block" : "none";
  cursorTrail.style.display = (cursorMode === "trail") ? "block" : "none";

  if (on && !cursorRAF) cursorLoop();
  if (!on && cursorRAF){
    cancelAnimationFrame(cursorRAF);
    cursorRAF = null;
  }
}
function cursorLoop(){
  tx += (cx - tx) * 0.18;
  ty += (cy - ty) * 0.18;

  cursorDot.style.left = cx + "px";
  cursorDot.style.top = cy + "px";
  if (cursorMode === "trail"){
    cursorTrail.style.left = tx + "px";
    cursorTrail.style.top = ty + "px";
  }
  cursorRAF = requestAnimationFrame(cursorLoop);
}
window.addEventListener("mousemove",(e)=>{ cx=e.clientX; cy=e.clientY; });

// ---- sound ping
let audioCtx = null;
function ping(){
  if (!settings.sounds) return;
  const vol = clamp01(settings.pingVolume ?? 0.65);
  try{
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = "sine";
    o.frequency.setValueAtTime(880, audioCtx.currentTime);
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.06 * vol, audioCtx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.12);
    o.connect(g); g.connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.14);
  }catch{}
}

// ---- layout vars
function applyLayout(){
  document.documentElement.style.setProperty("--density", String(settings.density ?? 0.10));
  document.documentElement.style.setProperty("--sidebar", String(settings.sidebar ?? 0.22));
  applyReduceAnimations();
  setCursorMode(settings.cursorMode || "trail");
}

// ---- UI overlays
function showLogin(show){
  loginScreen.style.display = show ? "flex" : "none";
}
function showLoading(show){
  loadingOverlay.classList.toggle("show", !!show);
}

// ---- modal
let modalOnClose = null;
function openModal(title, bodyHTML, footerHTML, onClose){
  modalTitle.textContent = title;
  modalBody.innerHTML = bodyHTML || "";
  modalFooter.innerHTML = footerHTML || "";
  modalOnClose = typeof onClose === "function" ? onClose : null;
  modalOverlay.classList.add("open");
}
function closeModal(){
  modalOverlay.classList.remove("open");
  const fn = modalOnClose;
  modalOnClose = null;
  if (fn) fn();
}
modalClose.onclick = closeModal;
modalOverlay.addEventListener("mousedown",(e)=>{ if (e.target === modalOverlay) closeModal(); });
window.addEventListener("keydown",(e)=>{ if (e.key==="Escape" && modalOverlay.classList.contains("open")) closeModal(); });

// ---- toast
function toast(title, msg, ms=1600){
  const div = document.createElement("div");
  div.className = "toast";
  div.innerHTML = `<b>${esc(title)}</b><span>${esc(msg)}</span>`;
  toasts.appendChild(div);
  setTimeout(()=>{
    div.style.opacity="0";
    div.style.transform="translateY(8px)";
    div.style.transition="opacity .12s ease, transform .12s ease";
    setTimeout(()=>div.remove(),160);
  }, ms);
}

// ---- cooldown UI
function startCooldownTicker(){
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(()=>{
    if (!globalCooldownUntil) { cooldownBox.style.display="none"; return; }
    const left = Math.max(0, globalCooldownUntil - Date.now());
    if (left <= 0){
      cooldownBox.style.display="none";
      globalCooldownUntil = 0;
      return;
    }
    cooldownBox.style.display = (view.kind==="global") ? "" : "none";
    cooldownText.textContent = `Cooldown ${(left/1000).toFixed(1)}s`;
  }, 80);
}
function warnCooldown(){
  cooldownBox.style.display = "";
  cooldownBox.classList.add("red","shake");
  setTimeout(()=> cooldownBox.classList.remove("shake"), 260);
  setTimeout(()=> cooldownBox.classList.remove("red"), 650);
}

// ---- render lists
function renderMessagesList(){
  messagesList.innerHTML = "";

  // Global always first
  messagesList.appendChild(makeItem({
    label:"Global",
    sub:"Public chat",
    meta: view.kind==="global" ? "•" : "",
    onClick: ()=>setViewGlobal()
  }));

  // DMs you HAVE = friends only (as requested)
  const friends = Array.isArray(social.friends) ? social.friends.slice().sort() : [];
  if (friends.length){
    for (const u of friends){
      messagesList.appendChild(makeItem({
        label:u,
        sub:"DM",
        meta: view.kind==="dm" && view.target===u ? "•" : "",
        onClick: ()=>setViewDM(u)
      }));
    }
  } else {
    messagesList.appendChild(makeHint("No DMs yet (add a friend)."));
  }

  // Group chats you're in
  if (myGroups.length){
    for (const g of myGroups){
      messagesList.appendChild(makeItem({
        label:g.name,
        sub:`GC • ${g.members.length} members`,
        meta: view.kind==="gc" && view.target===g.id ? "•" : "",
        onClick: ()=>setViewGC(g)
      }));
    }
  } else {
    messagesList.appendChild(makeHint("No group chats."));
  }

  // Leaderboard shortcut
  messagesList.appendChild(makeItem({
    label:"Leaderboard",
    sub:"Top XP",
    meta: view.kind==="leaderboard" ? "•" : "",
    onClick: ()=>setViewLeaderboard()
  }));

  // Tutorial shortcut when active / or allowed
  if (!me.guest){
    messagesList.appendChild(makeItem({
      label:"Tutorial",
      sub:"Learn the basics",
      meta: tutorialActive ? "•" : "",
      onClick: ()=>startTutorial(true)
    }));
  }
}

function renderOnlineList(users){
  onlineList.innerHTML = "";
  const list = Array.isArray(users) ? users : [];
  if (!list.length){
    onlineList.appendChild(makeHint("No one online"));
    return;
  }

  const names = list.map(x=>x.user).sort((a,b)=>a.localeCompare(b));
  for (const name of names){
    onlineList.appendChild(makeItem({
      label:name,
      sub: (tutorialActive && name === TUTORIAL_BOT) ? "Tutorial bot" : "Online",
      meta:"●",
      onClick: ()=>openProfile(name)
    }));
  }
}

function makeItem({label,sub,meta,onClick}){
  const el = document.createElement("div");
  el.className="item";
  el.innerHTML = `
    <div class="leftText">
      <div class="label">${esc(label)}</div>
      <div class="sub">${esc(sub||"")}</div>
    </div>
    <div class="meta">${esc(meta||"")}</div>
  `;
  el.onclick = onClick;
  return el;
}
function makeHint(text){
  const el = document.createElement("div");
  el.style.cssText = "color:rgba(233,238,245,.45);font-weight:900;padding:8px 6px;font-size:12px";
  el.textContent = text;
  return el;
}

// ---- chat
function clearChat(){ chatBody.innerHTML = ""; }
function addMessage(msg, blocked=false){
  const hidden = msg.text === "__HIDDEN_BY_FILTER__";
  const row = document.createElement("div");
  row.className = "msg" + (blocked ? " blocked" : "");
  const safeText = hidden ? "[message hidden by filter]" : msg.text;

  row.innerHTML = `
    <div class="u">${esc(msg.user)}</div>
    <div class="t">${esc(safeText)}</div>
    <div class="time">${esc(fmtTime(msg.ts))}</div>
    ${blocked ? `<div class="unblur">Show</div>` : ``}
  `;

  row.querySelector(".u").onclick = () => openProfile(msg.user);

  if (blocked){
    row.querySelector(".unblur").onclick = (e)=>{
      e.stopPropagation();
      row.classList.toggle("show");
      row.querySelector(".unblur").textContent = row.classList.contains("show") ? "Hide" : "Show";
    };
  }

  chatBody.appendChild(row);
  chatBody.scrollTop = chatBody.scrollHeight;
}
function setMessages(list){
  clearChat();
  for (const m of (list||[])){
    const blocked = !me.guest && social.blocked?.includes(m.user);
    addMessage(m, !!blocked);
  }
}

// ---- views
function setViewGlobal(){
  view = { kind:"global", target:null };
  chatTitle.textContent = "Global";
  chatSub.textContent = "Public chat";
  composer.style.display = "";
  cooldownBox.style.display = globalCooldownUntil ? "" : "none";
  clearChat();
  socket.emit("requestGlobalHistory");
  renderMessagesList();
}
function setViewDM(user){
  view = { kind:"dm", target:user };
  chatTitle.textContent = user;
  chatSub.textContent = "Direct message";
  composer.style.display = "";
  cooldownBox.style.display = "none";
  clearChat();
  socket.emit("dm:history", { withUser:user });
  renderMessagesList();
}
function setViewGC(group){
  view = { kind:"gc", target:group.id };
  chatTitle.textContent = group.name;
  chatSub.textContent = `Group chat • ${group.members.length} members`;
  composer.style.display = "";
  cooldownBox.style.display = "none";
  clearChat();
  socket.emit("group:history", { groupId:group.id });
  renderMessagesList();
}
function setViewLeaderboard(){
  view = { kind:"leaderboard", target:null };
  chatTitle.textContent = "Leaderboard";
  chatSub.textContent = "Top XP";
  composer.style.display = "none";
  cooldownBox.style.display = "none";
  renderLeaderboardChat();
  renderMessagesList();
  socket.emit("leaderboard:get");
}
function renderLeaderboardChat(){
  clearChat();
  if (!leaderboard.length){
    chatBody.appendChild(makeHint("No data yet."));
    return;
  }
  for (let i=0;i<leaderboard.length;i++){
    const r = leaderboard[i];
    const row = document.createElement("div");
    row.className = "msg";
    row.innerHTML = `
      <div class="u">#${i+1}</div>
      <div class="t"><b>${esc(r.user)}</b> • Lv ${esc(r.level)} (${esc(r.xp)}/${esc(r.next)})</div>
      <div class="time"></div>
    `;
    row.onclick = ()=>openProfile(r.user);
    chatBody.appendChild(row);
  }
}

// ---- sending
function sendCurrent(){
  const text = msgInput.value.trim();
  if (!text) return;

  if (view.kind === "global"){
    // client-side cooldown warning (server enforces too)
    if (globalCooldownUntil && Date.now() < globalCooldownUntil){
      warnCooldown();
      return;
    }
    socket.emit("sendGlobal", { text, ts: Date.now() });
    msgInput.value = "";
    return;
  }

  if (me.guest){
    toast("Guest", "Guests can only use Global chat.");
    return;
  }

  if (view.kind === "dm"){
    socket.emit("dm:send", { to:view.target, text });
    msgInput.value = "";
    return;
  }
  if (view.kind === "gc"){
    socket.emit("group:send", { groupId:view.target, text });
    msgInput.value = "";
    return;
  }
}
sendBtn.onclick = sendCurrent;
msgInput.addEventListener("keydown",(e)=>{ if (e.key==="Enter") sendCurrent(); });

// ---- inbox badge
function updateInboxBadge(){
  inboxBadge.textContent = String(inboxCount || 0);
  inboxBadge.classList.toggle("hidden", (inboxCount||0) <= 0);
}

// ---- user menu (click your name)
function openUserMenu(){
  const isG = me.guest;
  openModal(
    me.username,
    `
      <div style="color:rgba(233,238,245,.65);font-weight:900;font-size:12px">
        ${isG ? "Guest session" : "Account"}
      </div>
      <div style="height:10px"></div>
      ${!isG ? `<div style="border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px;margin-bottom:6px">Bio</div>
        <textarea id="bioEdit" style="width:100%;min-height:70px;border-radius:14px;border:1px solid rgba(255,255,255,.08);background:rgba(0,0,0,.18);color:var(--text);padding:10px;font-weight:800;outline:none;resize:vertical">${esc(bio)}</textarea>
        <div style="color:rgba(233,238,245,.55);font-weight:900;font-size:12px;margin-top:6px">Shown on your profile (max 180 chars).</div>
      </div>` : ``}
    `,
    `
      ${isG ? `<button class="btn" id="menuLogin">Log in</button>` : `<button class="btn" id="menuSettings">Settings</button>`}
      <button class="btn danger" id="menuLogout">${isG ? "Reset Guest" : "Log out"}</button>
    `
  );

  const login = $("menuLogin");
  if (login){
    login.onclick = ()=>{
      closeModal();
      // bring back login UI (guest can log in)
      saveToken(null);
      showLogin(true);
    };
  }

  const settingsBtn = $("menuSettings");
  if (settingsBtn){
    settingsBtn.onclick = ()=>{
      closeModal();
      openSettings();
    };
  }

  $("menuLogout").onclick = ()=>{
    closeModal();
    saveToken(null);
    socket.emit("logout");
    // hard reset UI to login screen
    me = { username:"Guest0000", guest:true, token:null, tutorialDone:true, isNew:false };
    social = { friends:[], incoming:[], outgoing:[], blocked:[] };
    myGroups = [];
    leaderboard = [];
    bio = "";
    inboxCount = 0;
    updateInboxBadge();
    meName.textContent = me.username;
    setViewGlobal();
    showLogin(true);
    toast("Logged out", "Session cleared.");
  };

  const bioEdit = $("bioEdit");
  if (bioEdit){
    bioEdit.addEventListener("input", ()=>{
      const v = bioEdit.value.slice(0,180);
      if (bioEdit.value !== v) bioEdit.value = v;
    });
    bioEdit.addEventListener("blur", ()=>{
      const v = bioEdit.value.slice(0,180);
      socket.emit("bio:update", { bio: v });
      bio = v;
    });
  }
}
mePill.onclick = openUserMenu;

// ---- inbox modal (NO SECTIONS)
function openInbox(){
  if (me.guest){
    openModal("Inbox", `<div style="color:rgba(233,238,245,.65);font-weight:900">Guests don’t have an inbox.</div>`, `<button class="btn" id="closeI">Close</button>`);
    $("closeI").onclick = closeModal;
    return;
  }
  socket.emit("inbox:get");
  openModal("Inbox", `<div style="color:rgba(233,238,245,.65);font-weight:900">Loading…</div>`, `<button class="btn" id="closeI">Close</button>`);
  $("closeI").onclick = closeModal;
}
inboxBtn.onclick = openInbox;

// ---- settings modal (no themes)
function openSettings(){
  if (me.guest){
    openModal("Settings", `<div style="color:rgba(233,238,245,.65);font-weight:900">Guests can’t save settings.</div>`, `<button class="btn" id="closeS">Close</button>`);
    $("closeS").onclick = closeModal;
    return;
  }

  const before = JSON.parse(JSON.stringify(settings));
  let saved = false;

  openModal(
    "Settings",
    `
    <div style="display:flex;flex-direction:column;gap:10px">

      <div style="padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px;margin-bottom:6px">Compactness</div>
        <input id="dens" type="range" min="0" max="1" step="0.01" value="${settings.density}" style="width:100%" />
      </div>

      <div style="padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px;margin-bottom:6px">Sidebar width</div>
        <input id="side" type="range" min="0" max="1" step="0.01" value="${settings.sidebar}" style="width:100%" />
      </div>

      <div style="padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px;margin-bottom:6px">Cursor</div>
        <select id="cursorPick" class="field">
          <option value="off">System cursor</option>
          <option value="dot">Minimal dot</option>
          <option value="trail">Dot + trail</option>
        </select>
      </div>

      <div style="padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:950;font-size:12px">Reduce animations</div>
            <div style="color:rgba(233,238,245,.55);font-weight:900;font-size:12px;margin-top:2px">Less motion / no shake.</div>
          </div>
          <input id="reduce" type="checkbox" ${settings.reduceAnimations ? "checked" : ""}/>
        </div>
      </div>

      <div style="padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:950;font-size:12px">Ping sound</div>
            <div style="color:rgba(233,238,245,.55);font-weight:900;font-size:12px;margin-top:2px">DMs / GCs / Inbox.</div>
          </div>
          <input id="snd" type="checkbox" ${settings.sounds ? "checked" : ""}/>
        </div>
        <div style="margin-top:10px">
          <div style="font-weight:950;font-size:12px;margin-bottom:6px">Ping volume</div>
          <input id="vol" type="range" min="0" max="1" step="0.01" value="${settings.pingVolume}" style="width:100%"/>
        </div>
      </div>

      <div style="padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px;margin-bottom:6px">Blocked users</div>
        <div id="blockedList" style="display:flex;flex-direction:column;gap:8px"></div>
      </div>

      <div style="padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px;margin-bottom:6px">Tutorial</div>
        <button class="btn" id="redoTut">Run tutorial again</button>
      </div>

    </div>
    `,
    `
      <button class="btn" id="saveS">Save</button>
      <button class="btn" id="closeS">Close</button>
    `,
    () => {
      if (saved) return;
      settings = before;
      applyLayout();
    }
  );

  const dens = $("dens");
  const side = $("side");
  const cursorPick = $("cursorPick");
  const reduce = $("reduce");
  const snd = $("snd");
  const vol = $("vol");

  cursorPick.value = settings.cursorMode || "trail";

  dens.oninput = () => { settings.density = clamp01(Number(dens.value)); applyLayout(); };
  side.oninput = () => { settings.sidebar = clamp01(Number(side.value)); applyLayout(); };
  cursorPick.onchange = () => { settings.cursorMode = cursorPick.value; applyLayout(); };
  reduce.onchange = () => { settings.reduceAnimations = !!reduce.checked; applyLayout(); };
  snd.onchange = () => { settings.sounds = !!snd.checked; };
  vol.oninput = () => { settings.pingVolume = clamp01(Number(vol.value)); };

  // blocked list
  const bl = $("blockedList");
  const blocked = Array.isArray(social.blocked) ? social.blocked : [];
  if (!blocked.length){
    bl.innerHTML = `<div style="color:rgba(233,238,245,.45);font-weight:900;font-size:12px">No blocked users</div>`;
  } else {
    bl.innerHTML = blocked.map(u=>`
      <div class="item" style="cursor:default">
        <div class="leftText">
          <div class="label">${esc(u)}</div>
          <div class="sub">Blocked</div>
        </div>
        <button class="btn" data-unblock="${esc(u)}">Unblock</button>
      </div>
    `).join("");
    bl.querySelectorAll("[data-unblock]").forEach(btn=>{
      btn.onclick = ()=>{
        const u = btn.getAttribute("data-unblock");
        socket.emit("user:unblock", { user:u });
        toast("Unblocked", u);
        // refresh social (server will send)
      };
    });
  }

  $("redoTut").onclick = ()=>{
    closeModal();
    startTutorial(true);
  };

  $("closeS").onclick = closeModal;
  $("saveS").onclick = ()=>{
    saved = true;
    socket.emit("settings:update", settings);
    toast("Settings", "Saved.");
    closeModal();
  };
}

// ---- tutorial (client-driven visuals)
function startTutorial(force=false){
  if (me.guest) return toast("Tutorial", "Log in to use tutorial.");
  if (tutorialActive && !force) return;

  tutorialActive = true;
  socket.emit("tutorial:setDone", { done:false });

  toast("Tutorial", "Step 1: Click your name (top right) to open the menu.");
  setTimeout(()=> toast("Tutorial", "Step 2: Use Settings to change cursor + reduce animations."), 1800);
  setTimeout(()=> toast("Tutorial", "Step 3: Use @username to mention someone (inbox)."), 3600);
  setTimeout(()=> toast("Tutorial", "Step 4: Click users to view profile, bio, and actions."), 5400);
  setTimeout(()=> toast("Tutorial", "Step 5: Open Leaderboard from Messages."), 7200);

  // show tutorial bot in online list (client-only)
  renderMessagesList();
  renderOnlineList(onlineUsersCacheWithTutorialBot());

  openModal(
    "Tutorial",
    `
      <div style="font-weight:950">Welcome to the tutorial.</div>
      <div style="color:rgba(233,238,245,.62);font-weight:900;margin-top:8px;font-size:12px">
        This tutorial is short and only shows important things. The Tutorial Bot will disappear when you finish.
      </div>
      <div style="height:10px"></div>
      <div style="border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px">Tutorial Bot</div>
        <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px;margin-top:6px">
          It appears in Online users during tutorial. Click it there to open its “profile”.
        </div>
      </div>
    `,
    `
      <button class="btn" id="finishTut">Finish tutorial</button>
      <button class="btn" id="skipTut">Skip</button>
    `
  );
  $("finishTut").onclick = finishTutorial;
  $("skipTut").onclick = finishTutorial;
}

function finishTutorial(){
  closeModal();
  tutorialActive = false;
  socket.emit("tutorial:setDone", { done:true });
  toast("Tutorial", "Done.");
  // bot vanishes
  renderOnlineList(onlineUsersCache);
  renderMessagesList();
}

let onlineUsersCache = [];
function onlineUsersCacheWithTutorialBot(){
  const base = onlineUsersCache.slice();
  if (!base.some(x=>x.user===TUTORIAL_BOT)) base.unshift({ user:TUTORIAL_BOT });
  return base;
}

// ---- profile modal with actions
function openProfile(user){
  if (user === TUTORIAL_BOT){
    openModal("Tutorial Bot", `<div style="font-weight:950">Hello 👋</div><div style="color:rgba(233,238,245,.62);font-weight:900;margin-top:8px;font-size:12px">Click your name to open menu, and open Settings.</div>`, `<button class="btn" id="closeP">Close</button>`);
    $("closeP").onclick = closeModal;
    return;
  }
  if (isGuest(user)){
    openModal("Profile", `<div style="font-weight:950">Guest</div><div style="color:rgba(233,238,245,.62);font-weight:900;margin-top:6px">${esc(user)}</div>`, `<button class="btn" id="closeP">Close</button>`);
    $("closeP").onclick = closeModal;
    return;
  }
  socket.emit("profile:get", { user });
}

// ---- inbox rendering (no sections)
function renderInbox(items){
  const list = Array.isArray(items) ? items : [];
  if (!list.length){
    modalBody.innerHTML = `<div style="color:rgba(233,238,245,.45);font-weight:900">No notifications</div>`;
    return;
  }
  modalBody.innerHTML = list.map(it=>{
    let title = "";
    let sub = "";
    if (it.type === "mention"){
      if (it.where === "global") title = `${it.from} mentioned you in Global Chat`;
      else if (it.where === "group") title = `${it.from} mentioned you in ${it.groupName || "a group"}`;
      else title = `${it.from} mentioned you`;
      sub = it.preview ? it.preview : "";
    } else if (it.type === "group_invite"){
      title = `${it.from} invited you to ${it.groupName || "a group"}`;
      sub = "Group invite";
    } else if (it.type === "friend_request"){
      title = `${it.from} sent you a friend request`;
      sub = "Friend request";
    } else {
      title = it.type;
      sub = "";
    }

    // action buttons
    let actions = `<button class="btn" data-clear="${esc(it.id)}">Clear</button>`;
    if (it.type === "friend_request"){
      actions = `
        <button class="btn" data-acc="${esc(it.from)}">Accept</button>
        <button class="btn" data-dec="${esc(it.from)}">Decline</button>
        <button class="btn" data-clear="${esc(it.id)}">Clear</button>
      `;
    }
    if (it.type === "group_invite"){
      actions = `
        <button class="btn" data-gacc="${esc(it.groupId)}">Accept</button>
        <button class="btn" data-gdec="${esc(it.groupId)}">Decline</button>
        <button class="btn" data-clear="${esc(it.id)}">Clear</button>
      `;
    }
    return `
      <div class="item" style="cursor:default;align-items:flex-start">
        <div class="leftText" style="min-width:0">
          <div class="label">${esc(title)}</div>
          <div class="sub">${esc(sub)}</div>
          <div class="sub" style="opacity:.7;margin-top:6px">${esc(new Date(it.ts||Date.now()).toLocaleString())}</div>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          ${actions}
        </div>
      </div>
    `;
  }).join("");

  // wire actions
  modalBody.querySelectorAll("[data-acc]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("friend:accept", { from: btn.getAttribute("data-acc") });
      ping();
      toast("Friend", "Accepted.");
      socket.emit("inbox:get");
    };
  });
  modalBody.querySelectorAll("[data-dec]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("friend:decline", { from: btn.getAttribute("data-dec") });
      toast("Friend", "Declined.");
      socket.emit("inbox:get");
    };
  });
  modalBody.querySelectorAll("[data-gacc]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("groupInvite:accept", { id: btn.getAttribute("data-gacc") });
      ping();
      toast("Group", "Joined.");
      socket.emit("groups:list");
      socket.emit("inbox:get");
    };
  });
  modalBody.querySelectorAll("[data-gdec]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("groupInvite:decline", { id: btn.getAttribute("data-gdec") });
      toast("Group", "Declined.");
      socket.emit("inbox:get");
    };
  });
  modalBody.querySelectorAll("[data-clear]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("inbox:clear", { id: btn.getAttribute("data-clear") });
    };
  });
}

// ---- login UI
eyeBtn.onclick = ()=>{ passInput.type = passInput.type==="password" ? "text" : "password"; };

loginBtn.onclick = ()=>{
  loginHint.textContent = "";
  showLoading(true);
  socket.emit("login", { username:userInput.value.trim(), password:passInput.value, guest:false });
};

guestBtn.onclick = ()=>{
  loginHint.textContent = "";
  showLoading(true);
  socket.emit("login", { guest:true });
};

passInput.addEventListener("keydown",(e)=>{ if (e.key==="Enter") loginBtn.click(); });
userInput.addEventListener("keydown",(e)=>{ if (e.key==="Enter") passInput.focus(); });

// ---- send during cooldown blocked by server
socket.on("cooldown:update", ({ globalUntil }={})=>{
  globalCooldownUntil = Number(globalUntil||0);
  if (view.kind==="global" && globalCooldownUntil > Date.now()){
    cooldownBox.style.display = "";
  }
});
socket.on("cooldown:blocked", ({ globalUntil }={})=>{
  globalCooldownUntil = Number(globalUntil||0);
  if (!settings.reduceAnimations) warnCooldown();
  else cooldownBox.classList.add("red");
});

// ---- socket events
socket.on("loginSuccess",(data)=>{
  // transitions: login -> loading -> app
  showLoading(false);

  me.username = data.username;
  me.guest = !!data.guest;
  me.token = data.token || null;
  me.isNew = !!data.isNew;
  me.tutorialDone = !!data.tutorialDone;

  settings = Object.assign(settings, data.settings || {});
  applyLayout();

  meName.textContent = me.username;

  // show app
  if (!settings.reduceAnimations){
    // brief loading flash for nice transition
    showLogin(false);
  } else {
    showLogin(false);
  }

  if (!me.guest && me.token) saveToken(me.token);
  else saveToken(null);

  bio = data.bio || "";
  social = data.social || social;

  // lists
  renderMessagesList();
  setViewGlobal();

  if (!me.guest){
    socket.emit("groups:list");
    socket.emit("leaderboard:get");
  }

  // tutorial prompt for brand new account
  if (!me.guest && me.isNew){
    openModal(
      "New account",
      `<div style="font-weight:950">Do you want a short tutorial?</div>
       <div style="color:rgba(233,238,245,.62);font-weight:900;margin-top:8px;font-size:12px">
         It shows settings, XP, mentions, and profiles.
       </div>`,
      `<button class="btn" id="tutYes">Start tutorial</button><button class="btn" id="tutNo">Skip</button>`
    );
    $("tutYes").onclick = ()=>{ closeModal(); startTutorial(true); };
    $("tutNo").onclick = ()=>{ closeModal(); socket.emit("tutorial:setDone", { done:true }); };
  }

  toast("Welcome", me.guest ? "Guest session started." : "Logged in.");
});

socket.on("loginError",(msg)=>{
  showLoading(false);
  loginHint.textContent = msg || "Login failed.";
});

socket.on("resumeFail", ()=>{
  showLoading(false);
  saveToken(null);
  showLogin(true);
});

socket.on("settings",(s)=>{
  settings = Object.assign(settings, s || {});
  applyLayout();
});

socket.on("bio:data",(d)=>{
  if (d && typeof d.bio === "string") bio = d.bio;
});

socket.on("social:update",(s)=>{
  social = s || social;
  renderMessagesList();
});

socket.on("leaderboard:data",(arr)=>{
  leaderboard = Array.isArray(arr) ? arr : [];
  if (view.kind==="leaderboard") renderLeaderboardChat();
});

socket.on("groups:list",(groups)=>{
  myGroups = Array.isArray(groups) ? groups : [];
  renderMessagesList();
  if (view.kind==="gc"){
    const g = myGroups.find(x=>x.id===view.target);
    if (g) chatSub.textContent = `Group chat • ${g.members.length} members`;
  }
});

socket.on("onlineUsers",(list)=>{
  onlineUsersCache = Array.isArray(list) ? list : [];
  const renderList = tutorialActive ? onlineUsersCacheWithTutorialBot() : onlineUsersCache;
  renderOnlineList(renderList);
});

socket.on("inbox:update", ({ count }={})=>{
  inboxCount = Number(count||0);
  updateInboxBadge();
});

socket.on("inbox:data",(items)=>{
  if (!modalOverlay.classList.contains("open")) return;
  if (modalTitle.textContent !== "Inbox") return;
  renderInbox(items);
  // badge will update via inbox:update
});

socket.on("history",(msgs)=>{
  if (view.kind !== "global") return;
  setMessages(msgs || []);
});

socket.on("globalMessage",(msg)=>{
  // Always append if viewing global
  if (view.kind === "global"){
    const blocked = !me.guest && social.blocked?.includes(msg.user);
    addMessage(msg, !!blocked);
  }
  // no red ping for global; mentions still go to inbox, server handles
});

socket.on("dm:history",(payload)=>{
  if (!payload) return;
  if (view.kind !== "dm") return;
  if (payload.withUser !== view.target) return;
  // if not friends, hide DM history by design
  if (!social.friends?.includes(view.target)) {
    setMessages([]);
    toast("DM hidden", "You are not friends with this user.");
    return;
  }
  setMessages(payload.msgs || []);
});

socket.on("dm:message",(payload)=>{
  if (!payload) return;
  const from = payload.from;
  const msg = payload.msg;

  // only show DM if friends
  if (!social.friends?.includes(from)) return;

  if (view.kind === "dm" && view.target === from){
    addMessage(msg, false);
  } else {
    ping();
    toast("DM", `New message from ${from}`);
  }
});

socket.on("group:history",(payload)=>{
  if (!payload) return;
  if (view.kind !== "gc") return;
  if (payload.groupId !== view.target) return;
  setMessages(payload.msgs || []);
  if (payload.meta){
    chatTitle.textContent = payload.meta.name;
    chatSub.textContent = `Group chat • ${payload.meta.members.length} members`;
  }
});

socket.on("group:message",(payload)=>{
  if (!payload) return;
  const gid = payload.groupId;
  const msg = payload.msg;

  if (view.kind === "gc" && view.target === gid){
    addMessage(msg, false);
  } else {
    ping();
    toast("Group", "New message in a group chat");
  }
});

socket.on("group:meta", ()=>{
  socket.emit("groups:list");
});

socket.on("group:left", ({ groupId }={})=>{
  if (view.kind==="gc" && view.target===groupId){
    setViewGlobal();
    toast("Group", "You left the group.");
  }
  socket.emit("groups:list");
});

socket.on("group:deleted", ({ groupId }={})=>{
  if (view.kind==="gc" && view.target===groupId){
    setViewGlobal();
    toast("Group", "Group deleted.");
  }
  socket.emit("groups:list");
});

socket.on("profile:data",(p)=>{
  if (!p) return;
  if (p.missing){
    openModal("Profile", `<div style="color:rgba(233,238,245,.65);font-weight:950">User not found</div>`, `<button class="btn" id="closeP">Close</button>`);
    $("closeP").onclick = closeModal;
    return;
  }
  if (p.guest){
    openModal("Profile", `<div style="font-weight:950">Guest</div><div style="color:rgba(233,238,245,.62);font-weight:900;margin-top:8px">${esc(p.user)}</div>`, `<button class="btn" id="closeP">Close</button>`);
    $("closeP").onclick = closeModal;
    return;
  }

  const created = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—";
  const xpPct = p.next ? Math.round((p.xp / p.next) * 100) : 0;
  const isMe = (!me.guest && p.user === me.username);

  const isFriend = !me.guest && social.friends?.includes(p.user);
  const isBlocked = !me.guest && social.blocked?.includes(p.user);

  openModal(
    "Profile",
    `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start">
        <div style="min-width:0">
          <div style="font-weight:950;font-size:14px">${esc(p.user)}</div>
          <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px;margin-top:4px">Created: ${esc(created)}</div>
        </div>
        <div style="color:rgba(233,238,245,.62);font-weight:950;font-size:12px;white-space:nowrap">Lv ${esc(p.level)}</div>
      </div>

      <div style="margin-top:10px;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px">Bio</div>
        <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px;margin-top:6px;white-space:pre-wrap">${esc(p.bio || "No bio yet.")}</div>
      </div>

      <div style="margin-top:10px;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
        <div style="display:flex;justify-content:space-between;gap:10px">
          <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px">Messages</div>
          <div style="font-weight:950;font-size:12px">${esc(p.messages)}</div>
        </div>
        <div style="margin-top:10px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px">XP</div>
        <div style="height:8px;border-radius:999px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);overflow:hidden;margin-top:6px">
          <div style="height:100%;width:${Math.max(0,Math.min(100,xpPct))}%;background:rgba(138,164,255,.85)"></div>
        </div>
        <div style="margin-top:6px;color:rgba(233,238,245,.55);font-weight:900;font-size:12px">${esc(p.xp)} / ${esc(p.next)}</div>
      </div>
    `,
    `
      <button class="btn" id="closeP">Close</button>
      ${(!me.guest && !isMe) ? `<button class="btn" id="addFriend">${isFriend ? "Unadd" : "Add friend"}</button>` : ``}
      ${(!me.guest && !isMe) ? `<button class="btn" id="dmBtn">DM</button>` : ``}
      ${(!me.guest && !isMe) ? `<button class="btn danger" id="blockBtn">${isBlocked ? "Unblock" : "Block"}</button>` : ``}
    `
  );

  $("closeP").onclick = closeModal;

  const addFriend = $("addFriend");
  if (addFriend){
    addFriend.onclick = ()=>{
      if (isFriend){
        socket.emit("friend:remove", { user:p.user });
        toast("Friend", "Removed.");
      } else {
        socket.emit("friend:request", { to:p.user });
        toast("Friend", "Request sent.");
      }
      closeModal();
    };
  }

  const dmBtn = $("dmBtn");
  if (dmBtn){
    dmBtn.onclick = ()=>{
      if (!social.friends?.includes(p.user)){
        toast("DM", "Add as friend to DM.");
        return;
      }
      closeModal();
      setViewDM(p.user);
    };
  }

  const blockBtn = $("blockBtn");
  if (blockBtn){
    blockBtn.onclick = ()=>{
      if (isBlocked){
        socket.emit("user:unblock", { user:p.user });
        toast("Unblocked", p.user);
      } else {
        socket.emit("user:block", { user:p.user });
        toast("Blocked", p.user);
      }
      closeModal();
    };
  }
});

socket.on("sendError",(e)=>{
  toast("Error", e?.reason || "Something went wrong.");
});

// ---- inbox button opens modal and refreshes data
function updateInboxBadge(){
  inboxBadge.textContent = String(inboxCount || 0);
  inboxBadge.classList.toggle("hidden", (inboxCount||0) <= 0);
}

// ---- boot
(function boot(){
  applyLayout();
  startCooldownTicker();
  updateInboxBadge();
  setViewGlobal();

  // Login persistence
  const token = loadToken();
  if (token){
    showLogin(false);
    showLoading(true);
    socket.emit("resume", { token });
  } else {
    showLogin(true);
  }
})();

