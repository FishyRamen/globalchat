const socket = io();
const $ = (id) => document.getElementById(id);

// --- UI ---
const loginOverlay = $("loginOverlay");
const loading = $("loading");
const shell = $("shell");

const usernameEl = $("username");
const passwordEl = $("password");
const joinBtn = $("joinBtn");
const guestBtn = $("guestBtn");
const togglePass = $("togglePass");

const mePill = $("mePill");
const meName = $("meName");
const brandSub = $("brandSub");

const inboxBtn = $("inboxBtn");
const inboxBadge = $("inboxBadge");
const settingsBtn = $("settingsBtn");
const logoutBtn = $("logoutBtn");
const loginBtn = $("loginBtn");

const tabGlobal = $("tabGlobal");
const tabMessages = $("tabMessages");
const sideList = $("sideList");

const chatTitle = $("chatTitle");
const chatHint = $("chatHint");
const chatActionBtn = $("chatActionBtn");

const chatBox = $("chatBox");
const composer = $("composer");
const messageEl = $("message");
const sendBtn = $("sendBtn");

const modalBack = $("modalBack");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
const modalClose = $("modalClose");

const toasts = $("toasts");
const cursorDot = $("cursorDot");
const cursorTrail = $("cursorTrail");

// --- State ---
let me = null;
let isGuest = false;
let token = localStorage.getItem("tonkotsu_token") || null;

let onlineUsers = [];
let settings = null;
let social = null;
let mutes = { dms: [], groups: [] };

let xp = null; // guests = null
let lastLevel = null;

let view = { type: "global", id: null }; // global | dm | group
let currentDM = null;
let currentGroupId = null;

let globalCache = [];
let dmCache = new Map();      // user -> msgs
let groupMeta = new Map();    // gid -> {id,name,owner,members[]}
let groupCache = new Map();   // gid -> msgs

// mild profanity (optional)
const MILD_WORDS = ["fuck","fucking","shit","shitty","asshole","bitch","bastard","dick","pussy"];
const MILD_RX = new RegExp(`\\b(${MILD_WORDS.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})\\b`, "ig");

// --- THEMES (NO GRADIENTS) ---
const THEMES = {
  dark:   { bg:"#0a0c10", panel:"rgba(255,255,255,.03)", panel2:"rgba(255,255,255,.02)", stroke:"rgba(255,255,255,.08)", stroke2:"rgba(255,255,255,.12)", text:"#e9eef5", muted:"rgba(233,238,245,.62)" },
  vortex: { bg:"#070a10", panel:"rgba(255,255,255,.03)", panel2:"rgba(255,255,255,.02)", stroke:"rgba(255,255,255,.08)", stroke2:"rgba(255,255,255,.12)", text:"#e9eef5", muted:"rgba(233,238,245,.62)" },
  abyss:  { bg:"#070b0d", panel:"rgba(255,255,255,.03)", panel2:"rgba(255,255,255,.02)", stroke:"rgba(255,255,255,.08)", stroke2:"rgba(255,255,255,.12)", text:"#e9eef5", muted:"rgba(233,238,245,.62)" },
  carbon: { bg:"#0b0b0c", panel:"rgba(255,255,255,.03)", panel2:"rgba(255,255,255,.02)", stroke:"rgba(255,255,255,.08)", stroke2:"rgba(255,255,255,.12)", text:"#e9eef5", muted:"rgba(233,238,245,.62)" },
};

function applyTheme(name){
  const t = THEMES[name] || THEMES.dark;
  const r = document.documentElement.style;
  r.setProperty("--bg", t.bg);
  r.setProperty("--panel", t.panel);
  r.setProperty("--panel2", t.panel2);
  r.setProperty("--stroke", t.stroke);
  r.setProperty("--stroke2", t.stroke2);
  r.setProperty("--text", t.text);
  r.setProperty("--muted", t.muted);
}
function applyDensity(val){
  const v = clamp(Number(val), 0, 1);
  const pad = Math.round(8 + v * 6);     // 8..14
  const font = Math.round(12 + v * 1);   // 12..13
  document.documentElement.style.setProperty("--pad", `${pad}px`);
  document.documentElement.style.setProperty("--font", `${font}px`);
}
function applySidebar(val){
  const v = clamp(Number(val), 0, 1);
  const w = Math.round(230 + v * 110); // 230..340
  document.documentElement.style.setProperty("--sidebarW", `${w}px`);
}

// --- helpers ---
function now(){ return Date.now(); }
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }

function escapeHtml(s){
  return String(s || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function fmtTime(ts){
  const d = new Date(ts);
  if(!Number.isFinite(d.getTime())) return "";
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
}
function showLoading(text="syncing…"){
  $("loaderSub").textContent = text;
  loading.classList.add("show");
}
function hideLoading(){
  loading.classList.remove("show");
}

// --- Toasts (NO alerts) ---
function toast(title, msg){
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
  setTimeout(() => { d.style.opacity="0"; d.style.transform="translateY(10px)"; }, 2600);
  setTimeout(() => d.remove(), 3100);
}

// --- Modal (single instance, always closable, never auto-opens) ---
let modalOnClose = null;
function openModal(title, html, onClose=null){
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalOnClose = typeof onClose === "function" ? onClose : null;
  modalBack.classList.add("show");
}
function closeModal(){
  modalBack.classList.remove("show");
  const cb = modalOnClose;
  modalOnClose = null;
  if (cb) cb();
}
modalClose.addEventListener("click", closeModal);
modalBack.addEventListener("click", (e)=>{ if(e.target===modalBack) closeModal(); });
document.addEventListener("keydown",(e)=>{ if(e.key==="Escape" && modalBack.classList.contains("show")) closeModal(); });

// --- Password eye ---
togglePass.addEventListener("click", () => {
  passwordEl.type = (passwordEl.type === "password") ? "text" : "password";
});

// --- Cursor (dynamic + trail, toggle in settings) ---
let cursorEnabled = true;
let cx = 0, cy = 0, tx = 0, ty = 0;
let cursorRAF = null;

function setCursorEnabled(on){
  cursorEnabled = !!on;
  document.body.classList.toggle("cursorOn", cursorEnabled);
  if (cursorEnabled && !cursorRAF) cursorLoop();
  if (!cursorEnabled && cursorRAF){
    cancelAnimationFrame(cursorRAF);
    cursorRAF = null;
  }
}
function cursorLoop(){
  // quick trail follow
  tx += (cx - tx) * 0.18;
  ty += (cy - ty) * 0.18;
  cursorDot.style.left = cx + "px";
  cursorDot.style.top = cy + "px";
  cursorTrail.style.left = tx + "px";
  cursorTrail.style.top = ty + "px";
  cursorRAF = requestAnimationFrame(cursorLoop);
}
window.addEventListener("mousemove",(e)=>{
  cx = e.clientX;
  cy = e.clientY;
});

// --- Settings preview behavior (does NOT save until Save) ---
function snapshotSettings(){
  return JSON.parse(JSON.stringify(settings || {}));
}

// --- Filter/hide rules ---
function maybeHideMild(text){
  if (!settings?.hideMildProfanity) return text;
  return String(text).replace(MILD_RX, "•••");
}
function isBlockedUser(u){
  return !!social?.blocked?.includes(u);
}

// server hard-hide marker
function applyHardHideMarker(text){
  if (String(text) === "__HIDDEN_BY_FILTER__") return "Message hidden.";
  return text;
}

// --- Pings (sound optional, badge only if >0) ---
let inboxCounts = { friend:0, group:0, total:0 };
function setInboxBadge(n){
  const v = Number(n) || 0;
  if (v > 0){
    inboxBadge.textContent = String(v);
    inboxBadge.classList.add("show");
  } else {
    inboxBadge.classList.remove("show");
  }
}

function playPing(){
  if (!settings?.sounds) return;
  // simple clean ping (no file needed)
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.0001;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.05, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.12);
    o.stop(ctx.currentTime + 0.14);
    setTimeout(()=>ctx.close().catch(()=>{}), 250);
  }catch{}
}

// --- View switching ---
function setView(type, id=null){
  view = { type, id };
  if(type==="global"){
    chatTitle.textContent = "Global";
    chatHint.textContent = "online users";
    chatActionBtn.style.display = "none";
    composer.style.display = "flex";
  } else if(type==="dm"){
    chatTitle.textContent = `DM — ${id}`;
    chatHint.textContent = "private messages";
    chatActionBtn.style.display = "none";
    composer.style.display = "flex";
  } else if(type==="group"){
    const meta = groupMeta.get(id);
    chatTitle.textContent = meta ? `Group — ${meta.name}` : "Group";
    chatHint.textContent = "group chat";
    chatActionBtn.style.display = "inline-block";
    composer.style.display = "flex";
  }
}

// --- Message rendering ---
function addMessageToUI({ user, text, ts }, { scope="global", from=null } = {}){
  const t = fmtTime(ts);
  const who = scope==="dm" ? from : user;
  if (!who) return;

  let bodyText = applyHardHideMarker(text);

  // blocked user handling (all scopes)
  if (isBlockedUser(who)) {
    bodyText = "Message hidden (blocked user).";
  } else {
    bodyText = maybeHideMild(bodyText);
  }

  const row = document.createElement("div");
  row.className = "msg";
  row.innerHTML = `
    <div class="meta">
      <div class="u" data-user="${escapeHtml(who)}">${escapeHtml(who)}</div>
      <div class="t">${escapeHtml(t)}</div>
    </div>
    <div class="body">${escapeHtml(bodyText)}</div>
  `;

  row.querySelector(".u").addEventListener("click", (e)=>{
    const u = e.target.getAttribute("data-user");
    openProfile(u);
  });

  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
}
function clearChat(){ chatBox.innerHTML = ""; }

// --- Sidebar rendering ---
function renderGlobalSidebar(){
  // Global tab = online users only
  sideList.innerHTML = onlineUsers.length
    ? onlineUsers.map(u => `
        <div class="row" data-profile="${escapeHtml(u.user)}">
          <div class="rowLeft">
            <div class="rowTitle">${escapeHtml(u.user)}</div>
            <div class="rowSub">click profile</div>
          </div>
        </div>
      `).join("")
    : `<div style="color:var(--muted);padding:8px">No one online.</div>`;

  sideList.querySelectorAll("[data-profile]").forEach(el=>{
    el.addEventListener("click", ()=> openProfile(el.getAttribute("data-profile")));
  });

  // In global view, show nothing in chat box except global messages history
  setView("global");
}

function renderMessagesSidebar(){
  // Messages tab = Global + your DMs + your GCs (no subtabs)
  const dmUsers = Array.from(dmCache.keys()).sort((a,b)=>a.localeCompare(b));
  const groups = Array.from(groupMeta.values()).sort((a,b)=>a.name.localeCompare(b.name));

  const globalRow = `
    <div class="row" id="msgGlobalRow">
      <div class="rowLeft">
        <div class="rowTitle">Global</div>
        <div class="rowSub">public chat</div>
      </div>
    </div>
  `;

  const dmRows = dmUsers.map(u => `
    <div class="row" data-dm="${escapeHtml(u)}" title="Right-click to mute/unmute">
      <div class="rowLeft">
        <div class="rowTitle">${escapeHtml(u)}</div>
        <div class="rowSub">dm</div>
      </div>
    </div>
  `).join("");

  const groupRows = groups.map(g => `
    <div class="row" data-group="${escapeHtml(g.id)}" title="Right-click to mute/unmute">
      <div class="rowLeft">
        <div class="rowTitle">${escapeHtml(g.name || "Unnamed Group")}</div>
        <div class="rowSub">${escapeHtml(g.id)}</div>
      </div>
    </div>
  `).join("");

  const createBtn = (!isGuest) ? `
    <button class="btn" id="createGroupBtn" style="width:100%">Create group</button>
  ` : "";

  sideList.innerHTML = `
    ${globalRow}
    ${dmRows || `<div style="color:var(--muted);padding:8px">No DMs yet.</div>`}
    ${groupRows || `<div style="color:var(--muted);padding:8px">No groups yet.</div>`}
    <div style="margin-top:8px">${createBtn}</div>
  `;

  $("msgGlobalRow").addEventListener("click", ()=> openGlobal(true));

  sideList.querySelectorAll("[data-dm]").forEach(el=>{
    const u = el.getAttribute("data-dm");
    el.addEventListener("click", ()=> openDM(u));
    el.addEventListener("contextmenu",(e)=>{
      e.preventDefault();
      toggleMute("dm", u);
    });
  });

  sideList.querySelectorAll("[data-group]").forEach(el=>{
    const gid = el.getAttribute("data-group");
    el.addEventListener("click", ()=> openGroup(gid));
    el.addEventListener("contextmenu",(e)=>{
      e.preventDefault();
      toggleMute("group", gid);
    });
  });

  const create = $("createGroupBtn");
  if (create){
    create.onclick = openCreateGroup;
  }
}

// --- Mute toggle ---
function isMuted(kind, id){
  if (kind === "dm") return mutes?.dms?.includes(id);
  if (kind === "group") return mutes?.groups?.includes(id);
  return false;
}
function toggleMute(kind, id){
  if (isGuest) { toast("Guests", "Guests can’t mute."); return; }
  const next = !isMuted(kind, id);
  socket.emit("mute:set", { kind, id, muted: next });
  toast(next ? "Muted" : "Unmuted", `${kind} ${id}`);
}

// --- Open global/dm/group ---
function openGlobal(force){
  currentDM = null;
  currentGroupId = null;

  tabGlobal.classList.add("active");
  tabMessages.classList.remove("active");

  setView("global");
  chatHint.textContent = "online users";
  chatActionBtn.style.display = "none";

  if (force){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, { scope:"global" }));
  }
  socket.emit("requestGlobalHistory");
  renderGlobalSidebar();
}

function openDM(user){
  if (isGuest){
    toast("Guests", "Guests can’t DM.");
    return;
  }
  currentDM = user;
  currentGroupId = null;

  tabGlobal.classList.remove("active");
  tabMessages.classList.add("active");

  setView("dm", user);
  clearChat();
  socket.emit("dm:history", { withUser: user });
}

function openGroup(gid){
  if (isGuest) return;
  currentGroupId = gid;
  currentDM = null;

  tabGlobal.classList.remove("active");
  tabMessages.classList.add("active");

  setView("group", gid);
  clearChat();
  socket.emit("group:history", { groupId: gid });
}

// --- Group management (simple + works) ---
function openGroupManage(gid){
  const meta = groupMeta.get(gid);
  if (!meta) return;

  const isOwner = meta.owner === me;
  const members = Array.isArray(meta.members) ? meta.members : [];

  const membersHtml = members.map(u => `
    <div class="row" data-member="${escapeHtml(u)}" style="cursor:default">
      <div class="rowLeft">
        <div class="rowTitle">${escapeHtml(u)}${u===meta.owner ? " (Owner)" : ""}${u===me ? " (You)" : ""}</div>
        <div class="rowSub">member</div>
      </div>
      ${isOwner && u!==meta.owner ? `<button class="btn" data-remove="${escapeHtml(u)}" style="padding:8px 10px">Remove</button>` : ``}
    </div>
  `).join("");

  openModal("Group", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="color:var(--muted);font-size:12px">
        <b style="color:rgba(233,238,245,.92)">${escapeHtml(meta.name || "Unnamed Group")}</b><br>
        id: ${escapeHtml(meta.id)}
      </div>

      <div style="display:flex;flex-direction:column;gap:8px">
        ${membersHtml}
      </div>

      <div style="color:var(--muted);font-size:12px">
        Tip: Right-click <b style="color:rgba(233,238,245,.9)">your name</b> to leave.
      </div>

      ${isOwner ? `
        <div style="display:flex;gap:8px;align-items:center">
          <input id="addUser" class="field" placeholder="Add member (username)" style="flex:1" />
          <button class="btn primary" id="addBtn" style="padding:10px 12px">Add</button>
        </div>
        <button class="btn" id="deleteBtn" style="border-color:rgba(255,77,77,.35)">Delete group</button>
      ` : `
        <button class="btn" id="leaveBtn" style="border-color:rgba(255,77,77,.35)">Leave group</button>
      `}
    </div>
  `);

  modalBody.querySelectorAll("[data-remove]").forEach(btn=>{
    btn.addEventListener("click",(e)=>{
      e.stopPropagation();
      socket.emit("group:removeMember", { groupId: gid, user: btn.getAttribute("data-remove") });
      toast("Group", "Removing…");
    });
  });

  modalBody.querySelectorAll("[data-member]").forEach(row=>{
    row.addEventListener("contextmenu",(e)=>{
      e.preventDefault();
      const u = row.getAttribute("data-member");
      if(u !== me) return;
      socket.emit("group:leave", { groupId: gid });
      closeModal();
      toast("Group", "Leaving…");
    });
  });

  if (isOwner){
    $("addBtn").onclick = ()=>{
      const u = $("addUser").value.trim();
      if (!u) return;
      socket.emit("group:addMember", { groupId: gid, user: u });
      toast("Group", "Adding…");
    };
    $("deleteBtn").onclick = ()=>{
      socket.emit("group:delete", { groupId: gid });
      closeModal();
      toast("Group", "Deleting…");
    };
  } else {
    $("leaveBtn").onclick = ()=>{
      socket.emit("group:leave", { groupId: gid });
      closeModal();
      toast("Group", "Leaving…");
    };
  }
}
chatActionBtn.addEventListener("click", ()=>{
  if (view.type === "group" && currentGroupId) openGroupManage(currentGroupId);
});

// --- Create group (invites required) ---
function openCreateGroup(){
  if (isGuest){ toast("Guests", "Guests can’t create groups."); return; }

  openModal("Create group", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="color:var(--muted);font-size:12px;line-height:1.45">
        Groups require invites to be created. Invite at least <b style="color:rgba(233,238,245,.9)">1 user</b>.
      </div>

      <input id="gcName" class="field" placeholder="Group name (optional)" />
      <input id="gcInvites" class="field" placeholder="Invite usernames (comma separated)" />

      <button class="btn primary" id="gcCreate">Send invites</button>
    </div>
  `);

  setTimeout(()=> $("gcInvites")?.focus(), 40);

  $("gcCreate").onclick = ()=>{
    const name = ($("gcName").value.trim() || "Unnamed Group");
    const raw = $("gcInvites").value.trim();
    const invites = raw.split(",").map(s=>s.trim()).filter(Boolean);
    socket.emit("group:createRequest", { name, invites });
    closeModal();
    toast("Group", "Sending invites…");
  };
}

// --- Profile popup (guests = only name) ---
function openProfile(user){
  if (!user) return;

  // guests: just name
  if (/^Guest\d{4,5}$/.test(String(user))){
    openModal("Profile", `
      <div style="font-weight:950;font-size:16px">${escapeHtml(user)}</div>
      <div style="color:var(--muted);font-size:12px">Guest</div>
    `);
    return;
  }

  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:950;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(user)}</div>
          <div id="profSub" style="color:var(--muted);font-size:12px">loading…</div>
        </div>
      </div>

      <div id="profXP" style="display:none"></div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Stats</div>
        <div id="profStats" style="display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px"></div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap" id="profActions"></div>
    </div>
  `);

  socket.emit("profile:get", { user });
  modalBody._profileUser = user;
}

// --- Inbox popup (simple) ---
function openInbox(){
  if (isGuest){
    openModal("Inbox", `<div style="color:var(--muted);font-size:12px">Guests have no inbox.</div>`);
    return;
  }
  openModal("Inbox", `<div style="color:var(--muted);font-size:12px">Loading…</div>`);
  socket.emit("inbox:get");
}

// --- Settings popup (preview only; save applies) ---
function openSettings(){
  const s = settings || {};
  const before = snapshotSettings();

  const themeKeys = ["dark","vortex","abyss","carbon"];
  const themeIndex = Math.max(0, themeKeys.indexOf(s.theme || "dark"));

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:10px">

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:6px">Theme</div>
        <select id="themePick" class="field">
          ${themeKeys.map(k=>`<option value="${k}" ${k===themeKeys[themeIndex]?"selected":""}>${k}</option>`).join("")}
        </select>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:6px">Compactness</div>
        <input id="densitySlider" type="range" min="0" max="1" step="0.01" value="${Number.isFinite(s.density)?s.density:0.10}" style="width:100%">
        <div style="color:var(--muted);font-size:12px;margin-top:6px">Compact ↔ Cozy</div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:6px">Sidebar width</div>
        <input id="sidebarSlider" type="range" min="0" max="1" step="0.01" value="${Number.isFinite(s.sidebar)?s.sidebar:0.20}" style="width:100%">
        <div style="color:var(--muted);font-size:12px;margin-top:6px">Narrow ↔ Wide</div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div>
          <div style="font-weight:900;font-size:12px">Custom cursor</div>
          <div style="color:var(--muted);font-size:12px">Dynamic cursor + short trail.</div>
        </div>
        <button class="btn" id="toggleCursor" style="padding:8px 12px">${s.cursor !== false ? "On" : "Off"}</button>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div>
          <div style="font-weight:900;font-size:12px">Ping sound</div>
          <div style="color:var(--muted);font-size:12px">DMs/Groups/Inbox only.</div>
        </div>
        <button class="btn" id="toggleSounds" style="padding:8px 12px">${s.sounds !== false ? "On" : "Off"}</button>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div>
          <div style="font-weight:900;font-size:12px">Hide mild profanity</div>
          <div style="color:var(--muted);font-size:12px">Masks f/s/a etc as •••.</div>
        </div>
        <button class="btn" id="toggleMild" style="padding:8px 12px">${s.hideMildProfanity ? "On" : "Off"}</button>
      </div>

      <div style="display:flex;gap:10px">
        <button class="btn primary" id="saveS" style="flex:1">Save</button>
        <button class="btn" id="cancelS" style="flex:1">Cancel</button>
      </div>
    </div>
  `, () => {
    // on close (escape/backdrop/close btn): revert preview if not saved
    settings = before;
    applyTheme(settings?.theme || "dark");
    applyDensity(settings?.density ?? 0.10);
    applySidebar(settings?.sidebar ?? 0.20);
    setCursorEnabled(settings?.cursor !== false);
  });

  // preview hooks
  const themePick = $("themePick");
  const densitySlider = $("densitySlider");
  const sidebarSlider = $("sidebarSlider");

  themePick.addEventListener("change", ()=>{
    settings.theme = themePick.value;
    applyTheme(settings.theme);
  });
  densitySlider.addEventListener("input", ()=>{
    settings.density = Number(densitySlider.value);
    applyDensity(settings.density);
  });
  sidebarSlider.addEventListener("input", ()=>{
    settings.sidebar = Number(sidebarSlider.value);
    applySidebar(settings.sidebar);
  });

  $("toggleCursor").onclick = ()=>{
    settings.cursor = !(settings.cursor === false);
    $("toggleCursor").textContent = settings.cursor ? "On" : "Off";
    setCursorEnabled(settings.cursor);
  };
  $("toggleSounds").onclick = ()=>{
    settings.sounds = !(settings.sounds === false);
    $("toggleSounds").textContent = settings.sounds ? "On" : "Off";
    if (settings.sounds) playPing();
  };
  $("toggleMild").onclick = ()=>{
    settings.hideMildProfanity = !settings.hideMildProfanity;
    $("toggleMild").textContent = settings.hideMildProfanity ? "On" : "Off";
  };

  $("cancelS").onclick = ()=>{
    // revert and close
    settings = before;
    applyTheme(settings?.theme || "dark");
    applyDensity(settings?.density ?? 0.10);
    applySidebar(settings?.sidebar ?? 0.20);
    setCursorEnabled(settings?.cursor !== false);
    closeModal();
  };

  $("saveS").onclick = ()=>{
    // save to server
    socket.emit("settings:update", settings);
    toast("Settings", "Saved.");
    closeModal();
  };
}

// --- Tabs ---
tabGlobal.addEventListener("click", ()=>{
  tabGlobal.classList.add("active");
  tabMessages.classList.remove("active");
  renderGlobalSidebar();
  openGlobal(true);
});

tabMessages.addEventListener("click", ()=>{
  tabGlobal.classList.remove("active");
  tabMessages.classList.add("active");
  renderMessagesSidebar();
  // keep current view if dm/group; otherwise open global messages
  if (view.type === "global") openGlobal(true);
});

// --- Composer send ---
sendBtn.addEventListener("click", sendCurrent);
messageEl.addEventListener("keydown",(e)=>{
  if (e.key === "Enter" && !e.shiftKey){
    e.preventDefault();
    sendCurrent();
  }
});

function sendCurrent(){
  if (!me) return;
  const text = messageEl.value.trim();
  if (!text) return;

  messageEl.value = "";

  if (view.type === "global"){
    socket.emit("sendGlobal", { text, ts: now() });
  } else if (view.type === "dm"){
    socket.emit("dm:send", { to: currentDM, text });
  } else if (view.type === "group"){
    socket.emit("group:send", { groupId: currentGroupId, text });
  }
}

// --- Auth buttons ---
settingsBtn.addEventListener("click", openSettings);
inboxBtn.addEventListener("click", openInbox);

logoutBtn.addEventListener("click", ()=>{
  showLoading("logging out…");
  setTimeout(()=>{
    localStorage.removeItem("tonkotsu_token");
    location.reload();
  }, 450);
});
loginBtn.addEventListener("click", ()=>{
  loginOverlay.classList.remove("hidden");
});

// --- Login ---
function shakeLogin(){
  const card = $("loginCard");
  card.style.animation = "none";
  card.offsetHeight;
  card.style.animation = "";
  card.classList.add("shake");
  setTimeout(()=> card.classList.remove("shake"), 350);
}
joinBtn.addEventListener("click", ()=>{
  const u = usernameEl.value.trim();
  const p = passwordEl.value;
  if (!u || !p){ shakeLogin(); return; }
  showLoading("logging in…");
  socket.emit("login", { username: u, password: p, guest:false });
});
guestBtn.addEventListener("click", ()=>{
  showLoading("joining as guest…");
  socket.emit("login", { guest:true });
});
passwordEl.addEventListener("keydown",(e)=>{ if(e.key==="Enter") joinBtn.click(); });

// --- Auto resume on refresh ---
(function tryResume(){
  if (token){
    socket.emit("resume", { token });
  }
})();

// --- Socket events ---
socket.on("resumeFail", ()=>{
  localStorage.removeItem("tonkotsu_token");
  token = null;
});

socket.on("loginError",(msg)=>{
  hideLoading();
  shakeLogin();
  toast("Login failed", msg || "Try again.");
});

socket.on("loginSuccess",(data)=>{
  hideLoading();

  me = data.username;
  isGuest = !!data.guest;
  settings = data.settings || { theme:"dark", density:0.10, sidebar:0.20, hideMildProfanity:false, cursor:true, sounds:true };
  social = data.social || { friends:[], incoming:[], outgoing:[], blocked:[] };
  xp = data.xp || null;
  lastLevel = xp?.level ?? null;

  // apply immediately
  applyTheme(settings?.theme || "dark");
  applyDensity(settings?.density ?? 0.10);
  applySidebar(settings?.sidebar ?? 0.20);
  setCursorEnabled(settings?.cursor !== false);

  // show app
  loginOverlay.classList.add("hidden");
  shell.style.display = "flex";
  mePill.style.display = "flex";
  meName.textContent = me;

  if (!isGuest && data.token){
    localStorage.setItem("tonkotsu_token", data.token);
    token = data.token;
    logoutBtn.style.display = "inline-block";
    loginBtn.style.display = "none";
    settingsBtn.style.display = "inline-flex";
    inboxBtn.style.display = "inline-flex";
    socket.emit("groups:list");
    socket.emit("mute:get");
  } else {
    // guest mode
    logoutBtn.style.display = "none";
    loginBtn.style.display = "inline-block";
    settingsBtn.style.display = "inline-flex"; // allow local settings
    inboxBtn.style.display = "inline-flex";    // opens guest message
  }

  brandSub.textContent = isGuest ? "guest" : "chat";

  toast("Welcome", isGuest ? "Joined as Guest" : `Logged in as ${me}`);

  // start global
  openGlobal(true);
});

socket.on("settings",(s)=>{
  // server pushed saved settings
  settings = s;
  applyTheme(settings?.theme || "dark");
  applyDensity(settings?.density ?? 0.10);
  applySidebar(settings?.sidebar ?? 0.20);
  setCursorEnabled(settings?.cursor !== false);
});

socket.on("mute:data",(m)=>{
  mutes = m || { dms: [], groups: [] };
});

socket.on("onlineUsers",(list)=>{
  onlineUsers = Array.isArray(list) ? list : [];
  if (tabGlobal.classList.contains("active")) renderGlobalSidebar();
});

socket.on("history",(msgs)=>{
  globalCache = (Array.isArray(msgs) ? msgs : [])
    .filter(m => Number.isFinite(new Date(m.ts).getTime()));
  if (view.type === "global"){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, { scope:"global" }));
  }
});

socket.on("globalMessage",(m)=>{
  if(!m || !Number.isFinite(new Date(m.ts).getTime())) return;
  globalCache.push(m);
  if (globalCache.length > 300) globalCache.shift();
  if (view.type === "global"){
    addMessageToUI(m, { scope:"global" });
  }
});

socket.on("dm:history",({ withUser, msgs })=>{
  const list = Array.isArray(msgs) ? msgs : [];
  dmCache.set(withUser, list);
  if (view.type === "dm" && currentDM === withUser){
    clearChat();
    list.forEach(m=> addMessageToUI(m, { scope:"dm", from: (m.user === me ? withUser : m.user) }));
  }
  if (tabMessages.classList.contains("active")) renderMessagesSidebar();
});

socket.on("dm:message",({ from, msg })=>{
  const list = dmCache.get(from) || [];
  list.push(msg);
  if (list.length > 300) list.shift();
  dmCache.set(from, list);

  // ping only if not muted and not currently viewing that dm
  if (!isMuted("dm", from) && !(view.type==="dm" && currentDM===from)){
    playPing();
  }

  if (view.type === "dm" && currentDM === from){
    addMessageToUI(msg, { scope:"dm", from });
  }

  if (tabMessages.classList.contains("active")) renderMessagesSidebar();
});

socket.on("groups:list",(list)=>{
  if (isGuest) return;
  groupMeta.clear();
  (Array.isArray(list)?list:[]).forEach(g=>{
    groupMeta.set(g.id, { id:g.id, name:g.name, owner:g.owner, members:g.members || [] });
  });
  if (tabMessages.classList.contains("active")) renderMessagesSidebar();
});

socket.on("group:history",({ groupId, meta, msgs })=>{
  groupMeta.set(groupId, meta);
  groupCache.set(groupId, msgs || []);
  currentGroupId = groupId;

  setView("group", groupId);

  clearChat();
  (msgs || []).forEach(m=> addMessageToUI(m, { scope:"group" }));
});

socket.on("group:message",({ groupId, msg })=>{
  if(!groupCache.has(groupId)) groupCache.set(groupId, []);
  const list = groupCache.get(groupId);
  list.push(msg);
  if (list.length > 350) list.shift();

  // ping only if not muted and not currently viewing
  if (!isMuted("group", groupId) && !(view.type==="group" && currentGroupId===groupId)){
    playPing();
  }

  if (view.type==="group" && currentGroupId===groupId){
    addMessageToUI(msg, { scope:"group" });
  }
});

socket.on("group:meta",({ groupId, meta })=>{
  groupMeta.set(groupId, meta);
  if (tabMessages.classList.contains("active")) renderMessagesSidebar();
  if (view.type==="group" && currentGroupId===groupId){
    chatTitle.textContent = `Group — ${meta.name}`;
  }
});

socket.on("group:left",({ groupId })=>{
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  if (view.type==="group" && currentGroupId===groupId){
    openGlobal(true);
  }
  if (tabMessages.classList.contains("active")) renderMessagesSidebar();
});

socket.on("group:deleted",({ groupId })=>{
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  if (view.type==="group" && currentGroupId===groupId){
    openGlobal(true);
  }
  if (tabMessages.classList.contains("active")) renderMessagesSidebar();
});

socket.on("group:requestCreated",({ name, invites })=>{
  toast("Group", `Invites sent for “${name}”`);
});

socket.on("inbox:counts",(c)=>{
  inboxCounts = c || { friend:0, group:0, total:0 };
  setInboxBadge(inboxCounts.total);
});

socket.on("inbox:data",({ friendRequests, groupInvites })=>{
  const fr = Array.isArray(friendRequests) ? friendRequests : [];
  const gi = Array.isArray(groupInvites) ? groupInvites : [];

  // Simple single-page popup (no “sections spam”)
  openModal("Inbox", `
    <div style="display:flex;flex-direction:column;gap:12px">

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Friend requests</div>
        ${fr.length ? fr.map(u=>`
          <div class="row" style="cursor:default">
            <div class="rowLeft">
              <div class="rowTitle">${escapeHtml(u)}</div>
              <div class="rowSub">request</div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn primary" data-accept="${escapeHtml(u)}" style="padding:8px 10px">Accept</button>
              <button class="btn" data-decline="${escapeHtml(u)}" style="padding:8px 10px">Decline</button>
            </div>
          </div>
        `).join("") : `<div style="color:var(--muted);font-size:12px">No requests.</div>`}
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Group invites</div>
        ${gi.length ? gi.map(inv=>`
          <div class="row" style="cursor:default">
            <div class="rowLeft">
              <div class="rowTitle">${escapeHtml(inv.name || "Unnamed Group")}</div>
              <div class="rowSub">from ${escapeHtml(inv.from)} • ${escapeHtml(inv.id)}</div>
            </div>
            <div style="display:flex;gap:8px">
              <button class="btn primary" data-gaccept="${escapeHtml(inv.id)}" style="padding:8px 10px">Join</button>
              <button class="btn" data-gdecline="${escapeHtml(inv.id)}" style="padding:8px 10px">Decline</button>
            </div>
          </div>
        `).join("") : `<div style="color:var(--muted);font-size:12px">No invites.</div>`}
      </div>
    </div>
  `);

  modalBody.querySelectorAll("[data-accept]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("friend:accept", { from: btn.getAttribute("data-accept") });
      toast("Friends", "Accepted.");
      openInbox();
    };
  });
  modalBody.querySelectorAll("[data-decline]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("friend:decline", { from: btn.getAttribute("data-decline") });
      toast("Friends", "Declined.");
      openInbox();
    };
  });
  modalBody.querySelectorAll("[data-gaccept]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("groupInvite:accept", { id: btn.getAttribute("data-gaccept") });
      toast("Group", "Joined.");
      socket.emit("groups:list");
      openInbox();
    };
  });
  modalBody.querySelectorAll("[data-gdecline]").forEach(btn=>{
    btn.onclick = ()=>{
      socket.emit("groupInvite:decline", { id: btn.getAttribute("data-gdecline") });
      toast("Group", "Declined.");
      openInbox();
    };
  });
});

socket.on("sendError",(e)=>{
  toast("Blocked", e?.reason || "Action blocked.");
});

// XP
socket.on("xp:update",(x)=>{
  xp = x || null;
});
socket.on("xp:levelUp",({ level })=>{
  if (isGuest) return;
  toast("Level up!", `You reached level ${level}.`);
});

// Profile data
socket.on("profile:data",(p)=>{
  const target = modalBody._profileUser;
  if (!target || p.user !== target) return;

  if (p.guest){
    modalBody.innerHTML = `
      <div style="font-weight:950;font-size:16px">${escapeHtml(p.user)}</div>
      <div style="color:var(--muted);font-size:12px">Guest</div>
    `;
    return;
  }
  if (p.missing){
    modalBody.innerHTML = `
      <div style="font-weight:950;font-size:16px">${escapeHtml(p.user)}</div>
      <div style="color:var(--muted);font-size:12px">User not found.</div>
    `;
    return;
  }

  const created = new Date(p.createdAt).toLocaleDateString(undefined, { year:"numeric", month:"short", day:"2-digit" });
  const pct = p.next ? Math.max(0, Math.min(1, p.xp / p.next)) : 0;

  const sub = modalBody.querySelector("#profSub");
  const stats = modalBody.querySelector("#profStats");
  const xpWrap = modalBody.querySelector("#profXP");
  const actions = modalBody.querySelector("#profActions");

  if (sub) sub.textContent = `Level ${p.level}`;

  if (xpWrap){
    xpWrap.style.display = "block";
    xpWrap.innerHTML = `
      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div style="font-weight:900;font-size:12px">XP</div>
          <div style="color:var(--muted);font-size:12px">${p.xp}/${p.next}</div>
        </div>
        <div style="margin-top:8px;height:10px;border-radius:999px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.05);overflow:hidden">
          <div style="height:100%;width:${Math.round(pct*100)}%;background:rgba(233,238,245,.22)"></div>
        </div>
      </div>
    `;
  }

  if (stats){
    stats.innerHTML = `
      <div>Account created: <b style="color:rgba(233,238,245,.92)">${escapeHtml(created)}</b></div>
      <div>Messages sent: <b style="color:rgba(233,238,245,.92)">${escapeHtml(p.messages)}</b></div>
    `;
  }

  if (actions){
    actions.innerHTML = "";
    if (!isGuest && p.user !== me){
      const dm = document.createElement("button");
      dm.className = "btn";
      dm.textContent = "DM";
      dm.onclick = ()=>{ closeModal(); openDM(p.user); };
      actions.appendChild(dm);

      const fr = document.createElement("button");
      fr.className = "btn primary";
      fr.textContent = "Add friend";
      fr.onclick = ()=>{ socket.emit("friend:request", { to: p.user }); toast("Friends", "Request sent."); };
      actions.appendChild(fr);

      const bl = document.createElement("button");
      bl.className = "btn";
      bl.textContent = "Block";
      bl.onclick = ()=>{ socket.emit("user:block", { user: p.user }); toast("Blocked", `${p.user} blocked.`); closeModal(); };
      actions.appendChild(bl);
    }
  }
});

// --- init footer year ---
$("year").textContent = String(new Date().getFullYear());
