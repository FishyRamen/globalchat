const socket = io();

const $ = (id) => document.getElementById(id);

const app = $("app");
const loginOverlay = $("loginOverlay");
const loginHint = $("loginHint");

const tabOnline = $("tabOnline");
const tabMessages = $("tabMessages");
const onlinePanel = $("onlinePanel");
const messagesPanel = $("messagesPanel");

const onlineList = $("onlineList");
const globalList = $("globalList");
const dmList = $("dmList");
const gcList = $("gcList");

const chatTitle = $("chatTitle");
const chatSub = $("chatSub");
const chatBody = $("chatBody");
const composer = $("composer");
const msgInput = $("msgInput");
const sendBtn = $("sendBtn");

const meName = $("meName");

const inboxBtn = $("inboxBtn");
const inboxBadge = $("inboxBadge");
const settingsBtn = $("settingsBtn");

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

const xpWrap = $("xpWrap");
const xpFill = $("xpFill");
const xpText = $("xpText");

const cursorDot = $("cursorDot");
const cursorTrail = $("cursorTrail");

// ---- state
let me = { username: "Guest0000", guest: true, token: null };
let settings = {
  theme: "dark",
  density: 0.10,
  sidebar: 0.22,
  cursorMode: "trail",
  sounds: true,
  pingVolume: 0.65
};

let view = { kind: "online", target: null }; // online | global | dm | gc
let onlineUsers = [];
let myDMs = [];      // array of usernames
let myGroups = [];   // array of {id,name,owner,members}
let inboxCounts = { friendRequests: 0, groupInvites: 0 };

let lastXPLevel = 1;

// ---- helpers
function clamp01(n){ return Math.max(0, Math.min(1, n)); }
function fmtTime(ts){
  try{
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }catch{ return ""; }
}
function esc(s){
  return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function isGuest(name){ return /^Guest\d{4,5}$/.test(String(name)); }

// ---- tabs
function setTab(which){
  if (which === "online"){
    tabOnline.classList.add("active");
    tabMessages.classList.remove("active");
    onlinePanel.style.display = "";
    messagesPanel.style.display = "none";
    setViewOnline();
  } else {
    tabOnline.classList.remove("active");
    tabMessages.classList.add("active");
    onlinePanel.style.display = "none";
    messagesPanel.style.display = "";
    // default in Messages is Global
    setViewGlobal();
  }
}
tabOnline.onclick = () => setTab("online");
tabMessages.onclick = () => setTab("messages");

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
modalOverlay.addEventListener("mousedown", (e)=>{
  if (e.target === modalOverlay) closeModal();
});
window.addEventListener("keydown", (e)=>{
  if (e.key === "Escape" && modalOverlay.classList.contains("open")) closeModal();
});

// ---- toast
function toast(title, msg, ms=1500){
  const div = document.createElement("div");
  div.className = "toast";
  div.innerHTML = `<b>${esc(title)}</b><span>${esc(msg)}</span>`;
  toasts.appendChild(div);
  setTimeout(()=>{
    div.style.opacity = "0";
    div.style.transform = "translateY(6px)";
    div.style.transition = "opacity .12s ease, transform .12s ease";
    setTimeout(()=> div.remove(), 160);
  }, ms);
}

// ---- cursor (3 modes)
let cursorMode = "trail"; // off | dot | trail
let cx = 0, cy = 0, tx = 0, ty = 0;
let cursorRAF = null;

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
window.addEventListener("mousemove",(e)=>{ cx = e.clientX; cy = e.clientY; });

// ---- sounds (simple clean ping)
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

// ---- apply settings to layout
function applyLayout(){
  document.documentElement.style.setProperty("--density", String(settings.density ?? 0.10));
  document.documentElement.style.setProperty("--sidebar", String(settings.sidebar ?? 0.22));
  setCursorMode(settings.cursorMode || "trail");
}

// ---- login persistence
function saveToken(t){
  try{
    if (t) localStorage.setItem("tonkotsu_token", t);
    else localStorage.removeItem("tonkotsu_token");
  }catch{}
}
function loadToken(){
  try{ return localStorage.getItem("tonkotsu_token"); }catch{ return null; }
}

// ---- login UI
eyeBtn.onclick = () => {
  passInput.type = passInput.type === "password" ? "text" : "password";
};

function showLogin(show){
  loginOverlay.style.display = show ? "flex" : "none";
}

loginBtn.onclick = () => {
  const u = userInput.value.trim();
  const p = passInput.value;
  loginHint.textContent = "";
  socket.emit("login", { username: u, password: p, guest: false });
};

guestBtn.onclick = () => {
  loginHint.textContent = "";
  socket.emit("login", { guest: true });
};

passInput.addEventListener("keydown",(e)=>{ if (e.key === "Enter") loginBtn.click(); });
userInput.addEventListener("keydown",(e)=>{ if (e.key === "Enter") passInput.focus(); });

// ---- views
function clearChat(){
  chatBody.innerHTML = "";
}

function setViewOnline(){
  view = { kind: "online", target: null };
  chatTitle.textContent = "Online";
  chatSub.textContent = "Online users";
  composer.style.display = "none";
  clearChat();
  renderOnlineInChat();
}
function setViewGlobal(){
  view = { kind: "global", target: null };
  chatTitle.textContent = "Global";
  chatSub.textContent = "Public chat";
  composer.style.display = "";
  clearChat();
  socket.emit("requestGlobalHistory");
}
function setViewDM(user){
  view = { kind: "dm", target: user };
  chatTitle.textContent = user;
  chatSub.textContent = "Direct message";
  composer.style.display = "";
  clearChat();
  socket.emit("dm:history", { withUser: user });
}
function setViewGC(group){
  view = { kind: "gc", target: group.id };
  chatTitle.textContent = group.name;
  chatSub.textContent = `Group chat • ${group.members.length} members`;
  composer.style.display = "";
  clearChat();
  socket.emit("group:history", { groupId: group.id });
}

// ---- list rendering
function renderOnlineList(){
  onlineList.innerHTML = "";
  if (!onlineUsers.length){
    onlineList.innerHTML = `<div style="color:rgba(233,238,245,.45);font-weight:800;padding:8px 6px;">No one online</div>`;
    return;
  }
  for (const u of onlineUsers){
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div style="min-width:0">
        <div class="label">${esc(u.user)}</div>
      </div>
      <div class="meta">●</div>
    `;
    el.onclick = () => openProfile(u.user);
    onlineList.appendChild(el);
  }
}

function renderGlobalItem(){
  globalList.innerHTML = "";
  const el = document.createElement("div");
  el.className = "item";
  el.innerHTML = `
    <div style="min-width:0">
      <div class="label">Global</div>
      <div class="sub">Public chat</div>
    </div>
    <div class="meta">↵</div>
  `;
  el.onclick = () => setViewGlobal();
  globalList.appendChild(el);
}

function renderDMList(){
  dmList.innerHTML = "";
  if (me.guest){
    dmList.innerHTML = `<div style="color:rgba(233,238,245,.45);font-weight:800;padding:8px 6px;">Guests can’t use DMs</div>`;
    return;
  }
  if (!myDMs.length){
    dmList.innerHTML = `<div style="color:rgba(233,238,245,.45);font-weight:800;padding:8px 6px;">No DMs yet</div>`;
    return;
  }
  for (const u of myDMs){
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div style="min-width:0">
        <div class="label">${esc(u)}</div>
        <div class="sub">DM</div>
      </div>
      <div class="meta">↵</div>
    `;
    el.onclick = () => setViewDM(u);
    dmList.appendChild(el);
  }
}

function renderGCList(){
  gcList.innerHTML = "";
  if (me.guest){
    gcList.innerHTML = `<div style="color:rgba(233,238,245,.45);font-weight:800;padding:8px 6px;">Guests can’t join groups</div>`;
    return;
  }
  if (!myGroups.length){
    gcList.innerHTML = `<div style="color:rgba(233,238,245,.45);font-weight:800;padding:8px 6px;">No group chats</div>`;
    return;
  }
  for (const g of myGroups){
    const el = document.createElement("div");
    el.className = "item";
    el.innerHTML = `
      <div style="min-width:0">
        <div class="label">${esc(g.name)}</div>
        <div class="sub">${g.members.length} members</div>
      </div>
      <div class="meta">↵</div>
    `;
    el.oncontextmenu = (e) => {
      e.preventDefault();
      openMuteMenu(`Mute group: ${g.name}`, () => toast("Muted", g.name));
    };
    el.onclick = () => setViewGC(g);
    gcList.appendChild(el);
  }
}

function renderOnlineInChat(){
  clearChat();
  if (!onlineUsers.length){
    chatBody.innerHTML = `<div style="color:rgba(233,238,245,.45);font-weight:800;padding:8px 6px;">No one online</div>`;
    return;
  }
  for (const u of onlineUsers){
    const row = document.createElement("div");
    row.className = "msg";
    row.innerHTML = `
      <div class="u">${esc(u.user)}</div>
      <div class="t" style="color:rgba(233,238,245,.65);font-weight:800;">online</div>
      <div class="time"></div>
    `;
    row.querySelector(".u").onclick = () => openProfile(u.user);
    chatBody.appendChild(row);
  }
}

// ---- chat rendering
function addMessage(msg){
  const hidden = msg.text === "__HIDDEN_BY_FILTER__";
  const row = document.createElement("div");
  row.className = "msg" + (hidden ? " hidden" : "");
  const safeText = hidden ? "[message hidden by filter]" : msg.text;

  row.innerHTML = `
    <div class="u">${esc(msg.user)}</div>
    <div class="t">${esc(safeText)}</div>
    <div class="time">${esc(fmtTime(msg.ts))}</div>
  `;
  row.querySelector(".u").onclick = () => openProfile(msg.user);

  chatBody.appendChild(row);
  chatBody.scrollTop = chatBody.scrollHeight;
}

function setMessages(list){
  clearChat();
  for (const m of list) addMessage(m);
}

// ---- XP
function updateXP(xp){
  if (!xp || me.guest){
    xpWrap.style.display = "none";
    return;
  }
  xpWrap.style.display = "";
  const level = xp.level ?? 1;
  const cur = xp.xp ?? 0;
  const next = xp.next ?? 120;
  const pct = next ? (cur / next) : 0;
  xpFill.style.width = `${Math.round(clamp01(pct) * 100)}%`;
  xpText.textContent = `Lv ${level}`;

  if (level > lastXPLevel){
    toast("Level up!", `You reached level ${level}.`);
    ping();
  }
  lastXPLevel = level;
}

// ---- inbox badge
function updateInboxBadge(){
  const total = (inboxCounts.friendRequests || 0) + (inboxCounts.groupInvites || 0);
  inboxBadge.textContent = String(total);
  inboxBadge.classList.toggle("hidden", total <= 0);
}

// ---- profile modal
function openProfile(user){
  if (isGuest(user)){
    openModal("Profile", `<div style="font-weight:900">Guest</div><div style="color:rgba(233,238,245,.62);margin-top:6px">${esc(user)}</div>`,
      `<button class="btn" id="closeP">Close</button>`,
      null
    );
    $("closeP").onclick = closeModal;
    return;
  }
  socket.emit("profile:get", { user });
}

socket.on("profile:data",(p)=>{
  if (!p) return;
  if (p.missing){
    openModal("Profile", `<div style="color:rgba(233,238,245,.65);font-weight:900">User not found</div>`,
      `<button class="btn" id="closeP">Close</button>`
    );
    $("closeP").onclick = closeModal;
    return;
  }

  const created = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—";
  const level = p.level ? `Lv ${p.level}` : "";
  const msgs = Number.isFinite(p.messages) ? p.messages : 0;
  const xpPct = p.next ? Math.round((p.xp / p.next) * 100) : 0;

  openModal(
    "Profile",
    `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:14px">${esc(p.user)}</div>
      <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px">${esc(level)}</div>
    </div>

    <div style="margin-top:10px;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:12px;background:rgba(255,255,255,.02)">
      <div style="display:flex;justify-content:space-between;gap:10px">
        <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px">Created</div>
        <div style="font-weight:950;font-size:12px">${esc(created)}</div>
      </div>
      <div style="display:flex;justify-content:space-between;gap:10px;margin-top:8px">
        <div style="color:rgba(233,238,245,.62);font-weight:900;font-size:12px">Messages</div>
        <div style="font-weight:950;font-size:12px">${esc(msgs)}</div>
      </div>

      <div style="margin-top:10px;color:rgba(233,238,245,.62);font-weight:900;font-size:12px">XP</div>
      <div style="height:8px;border-radius:999px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.03);overflow:hidden;margin-top:6px">
        <div style="height:100%;width:${Math.max(0,Math.min(100,xpPct))}%;background:rgba(138,164,255,.85)"></div>
      </div>
      <div style="margin-top:6px;color:rgba(233,238,245,.55);font-weight:800;font-size:12px">${esc(p.xp)} / ${esc(p.next)}</div>
    </div>
    `,
    `
      <button class="btn" id="closeP">Close</button>
      ${(!me.guest && me.username !== p.user) ? `<button class="btn" id="dmP">DM</button>` : ``}
    `
  );

  $("closeP").onclick = closeModal;
  const dmBtn = $("dmP");
  if (dmBtn){
    dmBtn.onclick = ()=>{
      closeModal();
      if (!myDMs.includes(p.user)) myDMs.unshift(p.user);
      renderDMList();
      setTab("messages");
      setViewDM(p.user);
    };
  }
});

// ---- mute menu (right click)
function openMuteMenu(title, onMute){
  openModal(
    title,
    `<div style="color:rgba(233,238,245,.65);font-weight:800;font-size:12px">Right-click mute placeholder (client-side only for now).</div>`,
    `<button class="btn" id="muteOk">Mute</button><button class="btn" id="muteClose">Close</button>`
  );
  $("muteOk").onclick = ()=>{
    closeModal();
    onMute && onMute();
  };
  $("muteClose").onclick = closeModal;
}

// ---- settings modal
function openSettings(){
  if (me.guest){
    toast("Guest", "Guests can’t save settings.");
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
        <div style="color:rgba(233,238,245,.55);font-weight:800;font-size:12px;margin-top:6px">Tightens spacing + font scale (smooth).</div>
      </div>

      <div style="padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px;margin-bottom:6px">Sidebar width</div>
        <input id="side" type="range" min="0" max="1" step="0.01" value="${settings.sidebar}" style="width:100%" />
        <div style="color:rgba(233,238,245,.55);font-weight:800;font-size:12px;margin-top:6px">Narrower / wider messages panel.</div>
      </div>

      <div style="padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02)">
        <div style="font-weight:950;font-size:12px;margin-bottom:6px">Cursor</div>
        <select id="cursorModePick" class="field">
          <option value="off">System cursor</option>
          <option value="dot">Minimal dot</option>
          <option value="trail">Dot + trail</option>
        </select>
        <div style="color:rgba(233,238,245,.55);font-weight:800;font-size:12px;margin-top:6px">Choose your cursor style.</div>
      </div>

      <div style="padding:12px;border:1px solid rgba(255,255,255,.08);border-radius:16px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:950;font-size:12px">Ping sound</div>
            <div style="color:rgba(233,238,245,.55);font-weight:800;font-size:12px;margin-top:2px">For DMs/GCs/Inbox (not Global).</div>
          </div>
          <input id="snd" type="checkbox" ${settings.sounds ? "checked" : ""} />
        </div>
        <div style="margin-top:10px">
          <div style="font-weight:950;font-size:12px;margin-bottom:6px">Ping volume</div>
          <input id="vol" type="range" min="0" max="1" step="0.01" value="${settings.pingVolume}" style="width:100%" />
        </div>
      </div>

    </div>
    `,
    `
      <button class="btn" id="saveS">Save</button>
      <button class="btn" id="closeS">Close</button>
    `,
    () => {
      // IMPORTANT: only revert if not saved
      if (saved) return;
      settings = before;
      applyLayout();
    }
  );

  const dens = $("dens");
  const side = $("side");
  const cursorPick = $("cursorModePick");
  const snd = $("snd");
  const vol = $("vol");

  cursorPick.value = settings.cursorMode || "trail";

  dens.oninput = () => { settings.density = clamp01(Number(dens.value)); applyLayout(); };
  side.oninput = () => { settings.sidebar = clamp01(Number(side.value)); applyLayout(); };
  cursorPick.onchange = () => { settings.cursorMode = cursorPick.value; applyLayout(); };
  snd.onchange = () => { settings.sounds = !!snd.checked; };
  vol.oninput = () => { settings.pingVolume = clamp01(Number(vol.value)); };

  $("closeS").onclick = closeModal;
  $("saveS").onclick = () => {
    saved = true;
    socket.emit("settings:update", settings);
    toast("Settings", "Saved.");
    closeModal();
  };
}

// ---- inbox modal
function openInbox(){
  if (me.guest){
    openModal(
      "Inbox",
      `<div style="color:rgba(233,238,245,.65);font-weight:900">Guests don’t have an inbox.</div>`,
      `<button class="btn" id="closeI">Close</button>`
    );
    $("closeI").onclick = closeModal;
    return;
  }

  socket.emit("inbox:get");

  openModal(
    "Inbox",
    `<div style="color:rgba(233,238,245,.65);font-weight:900">Loading…</div>`,
    `<button class="btn" id="closeI">Close</button>`
  );
  $("closeI").onclick = closeModal;
}

// ---- events
settingsBtn.onclick = openSettings;
inboxBtn.onclick = openInbox;

// ---- sending messages
function sendCurrent(){
  const text = msgInput.value.trim();
  if (!text) return;
  msgInput.value = "";

  if (view.kind === "global"){
    socket.emit("sendGlobal", { text, ts: Date.now() });
    return;
  }
  if (view.kind === "dm"){
    socket.emit("dm:send", { to: view.target, text });
    return;
  }
  if (view.kind === "gc"){
    socket.emit("group:send", { groupId: view.target, text });
    return;
  }
}
sendBtn.onclick = sendCurrent;
msgInput.addEventListener("keydown",(e)=>{ if (e.key === "Enter") sendCurrent(); });

// ---- socket handlers
socket.on("loginSuccess",(data)=>{
  me.username = data.username;
  me.guest = !!data.guest;
  me.token = data.token || null;
  meName.textContent = me.username;

  settings = Object.assign(settings, data.settings || {});
  applyLayout();

  showLogin(false);

  if (!me.guest && data.token){
    saveToken(data.token);
  } else {
    saveToken(null);
  }

  lastXPLevel = (data.xp && data.xp.level) ? data.xp.level : 1;
  updateXP(data.xp);

  renderGlobalItem();

  // get groups list if logged in
  if (!me.guest){
    socket.emit("groups:list");
  }

  setTab("online");
});

socket.on("loginError",(msg)=>{
  loginHint.textContent = msg || "Login failed.";
});

socket.on("resumeFail", ()=>{
  saveToken(null);
  showLogin(true);
});

socket.on("settings",(s)=>{
  settings = Object.assign(settings, s || {});
  applyLayout();
});

socket.on("xp:update",(xp)=>{
  updateXP(xp);
});

socket.on("onlineUsers",(list)=>{
  onlineUsers = Array.isArray(list) ? list : [];
  renderOnlineList();
  if (view.kind === "online") renderOnlineInChat();
});

socket.on("history",(msgs)=>{
  if (view.kind !== "global") return;
  setMessages(msgs || []);
});

socket.on("globalMessage",(msg)=>{
  if (view.kind === "global"){
    addMessage(msg);
  }
  // no red ping for global by request
});

socket.on("dm:history",(payload)=>{
  if (!payload) return;
  if (view.kind !== "dm") return;
  if (payload.withUser !== view.target) return;
  setMessages(payload.msgs || []);
});

socket.on("dm:message",(payload)=>{
  if (!payload) return;
  const from = payload.from;
  const msg = payload.msg;

  // maintain list
  if (!myDMs.includes(from)) myDMs.unshift(from);
  renderDMList();

  // if currently in that DM, show
  if (view.kind === "dm" && view.target === from){
    addMessage(msg);
  } else {
    // ping + badge only for DM/GC/inbox style; we keep it simple: ping sound only
    ping();
  }
});

socket.on("groups:list",(groups)=>{
  myGroups = Array.isArray(groups) ? groups : [];
  renderGCList();
});

socket.on("group:history",(payload)=>{
  if (!payload) return;
  if (view.kind !== "gc") return;
  if (payload.groupId !== view.target) return;
  setMessages(payload.msgs || []);
  // update subtitle from meta
  if (payload.meta){
    chatTitle.textContent = payload.meta.name;
    chatSub.textContent = `Group chat • ${payload.meta.members.length} members`;
  }
});

socket.on("group:message",(payload)=>{
  if (!payload) return;
  const gid = payload.groupId;
  const msg = payload.msg;

  // if currently viewing this group, show
  if (view.kind === "gc" && view.target === gid){
    addMessage(msg);
  } else {
    ping();
  }
});

socket.on("group:meta",(payload)=>{
  // refresh group list
  socket.emit("groups:list");
});

socket.on("inbox:update",(counts)=>{
  inboxCounts = Object.assign(inboxCounts, counts || {});
  updateInboxBadge();
});

socket.on("inbox:data",(data)=>{
  if (!modalOverlay.classList.contains("open")) return;
  if (modalTitle.textContent !== "Inbox") return;

  const friends = Array.isArray(data.friendRequests) ? data.friendRequests : [];
  const invites = Array.isArray(data.groupInvites) ? data.groupInvites : [];

  inboxCounts.friendRequests = friends.length;
  inboxCounts.groupInvites = invites.length;
  updateInboxBadge();

  const friendsHTML = friends.length
    ? friends.map(u => `
        <div class="item" style="margin-bottom:8px">
          <div style="min-width:0">
            <div class="label">${esc(u)}</div>
            <div class="sub">Friend request</div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn" data-acc="${esc(u)}">Accept</button>
            <button class="btn" data-dec="${esc(u)}">Decline</button>
          </div>
        </div>
      `).join("")
    : `<div style="color:rgba(233,238,245,.45);font-weight:800;padding:6px 2px">No friend requests</div>`;

  const invitesHTML = invites.length
    ? invites.map(inv => `
        <div class="item" style="margin-bottom:8px">
          <div style="min-width:0">
            <div class="label">${esc(inv.name || "Unnamed Group")}</div>
            <div class="sub">Invite from ${esc(inv.from)}</div>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn" data-gacc="${esc(inv.id)}">Accept</button>
            <button class="btn" data-gdec="${esc(inv.id)}">Decline</button>
          </div>
        </div>
      `).join("")
    : `<div style="color:rgba(233,238,245,.45);font-weight:800;padding:6px 2px">No group invites</div>`;

  modalBody.innerHTML = `
    <div class="sectionTitle" style="margin-top:0">Friend requests</div>
    ${friendsHTML}
    <div class="sectionTitle" style="margin-top:12px">Group chat invites</div>
    ${invitesHTML}
  `;

  // wire buttons
  modalBody.querySelectorAll("[data-acc]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("friend:accept", { from: btn.getAttribute("data-acc") });
      toast("Friend", "Request accepted.");
      socket.emit("inbox:get");
    };
  });
  modalBody.querySelectorAll("[data-dec]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("friend:decline", { from: btn.getAttribute("data-dec") });
      toast("Friend", "Request declined.");
      socket.emit("inbox:get");
    };
  });
  modalBody.querySelectorAll("[data-gacc]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("groupInvite:accept", { id: btn.getAttribute("data-gacc") });
      toast("Group", "Invite accepted.");
      socket.emit("inbox:get");
      socket.emit("groups:list");
    };
  });
  modalBody.querySelectorAll("[data-gdec]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("groupInvite:decline", { id: btn.getAttribute("data-gdec") });
      toast("Group", "Invite declined.");
      socket.emit("inbox:get");
    };
  });
});

socket.on("sendError",(e)=>{
  toast("Error", e?.reason || "Something went wrong.");
});

// ---- initial boot: try resume
(function boot(){
  applyLayout();
  renderGlobalItem();
  renderDMList();
  renderGCList();
  setViewOnline();
  updateInboxBadge();

  const token = loadToken();
  if (token){
    socket.emit("resume", { token });
    showLogin(false); // show later if resume fails
  } else {
    showLogin(true);
  }
})();
