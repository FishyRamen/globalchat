const socket = io();
const $ = (id) => document.getElementById(id);

// UI
const loginOverlay = $("loginOverlay");
const loading = $("loading");
const app = $("app");

const usernameEl = $("username");
const passwordEl = $("password");
const joinBtn = $("joinBtn");
const guestBtn = $("guestBtn");
const togglePass = $("togglePass");

const mePill = $("mePill");
const meName = $("meName");

const tabGlobal = $("tabGlobal");
const tabMessages = $("tabMessages");
const tabInbox = $("tabInbox");
const msgPing = $("msgPing");
const inboxPing = $("inboxPing");
const sideSection = $("sideSection");

const chatTitle = $("chatTitle");
const chatHint = $("chatHint");
const backBtn = $("backBtn");

const chatBox = $("chatBox");
const messageEl = $("message");
const sendBtn = $("sendBtn");

const cooldownRow = $("cooldownRow");
const cooldownText = $("cooldownText");
const cdFill = $("cdFill");

const settingsBtn = $("settingsBtn");
const logoutBtn = $("logoutBtn");
const loginBtn = $("loginBtn");

const modalBack = $("modalBack");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
const modalClose = $("modalClose");

const toasts = $("toasts");

// State
let me = null;
let isGuest = false;
let token = localStorage.getItem("tonkotsu_token") || null;

let onlineUsers = [];
let settings = null;
let social = null;
let xp = { level: 1, xp: 0, next: 120 };

let view = { type: "global", id: null }; // global | dm | group
let currentDM = null;
let currentGroupId = null;

let globalCache = [];
let dmCache = new Map();        // user -> msgs
let groupMeta = new Map();      // gid -> {id,name,owner,members[]}
let groupCache = new Map();     // gid -> msgs

let cooldownUntil = 0;

// mild profanity list (allowed but optionally hidden client-side)
const MILD_WORDS = [
  "fuck","fucking","shit","shitty","asshole","bitch","bastard","dick","pussy"
];
const MILD_RX = new RegExp(`\\b(${MILD_WORDS.map(w=>w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})\\b`, "ig");

// ---------- THEMES (no gradients) ----------
const THEMES = {
  dark:   { bg:"#0b0d10", panel:"rgba(255,255,255,.02)", stroke:"#1c232c", stroke2:"#242c36", text:"#e8edf3", muted:"#9aa7b3" },
  vortex: { bg:"#070913", panel:"rgba(120,140,255,.06)", stroke:"#1a2240", stroke2:"#28305c", text:"#eaf0ff", muted:"#9aa7d6" },
  abyss:  { bg:"#060a0b", panel:"rgba(80,255,220,.05)",  stroke:"#12312c", stroke2:"#1c3f37", text:"#e8fff9", muted:"#8abfb3" },
  carbon: { bg:"#0c0d0e", panel:"rgba(255,255,255,.035)", stroke:"#272a2e", stroke2:"#343840", text:"#f2f4f7", muted:"#a0a8b3" },
};

function applyTheme(name){
  const t = THEMES[name] || THEMES.dark;
  const r = document.documentElement.style;
  r.setProperty("--bg", t.bg);
  r.setProperty("--panel", t.panel);
  r.setProperty("--stroke", t.stroke);
  r.setProperty("--stroke2", t.stroke2);
  r.setProperty("--text", t.text);
  r.setProperty("--muted", t.muted);
}

function applyDensity(val){
  // val 0..1
  const v = Math.max(0, Math.min(1, Number(val)));
  const pad = Math.round(10 + v * 10);  // 10..20
  const font = Math.round(12 + v * 2);  // 12..14
  const r = document.documentElement.style;
  r.setProperty("--pad", `${pad}px`);
  r.setProperty("--font", `${font}px`);
}

// ---------- helpers ----------
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
  setTimeout(() => { d.style.opacity="0"; d.style.transform="translateY(10px)"; }, 2800);
  setTimeout(() => d.remove(), 3300);
}

function showLoading(text="syncing…"){
  $("loaderSub").textContent = text;
  loading.classList.add("show");
}
function hideLoading(){
  loading.classList.remove("show");
}

function openModal(title, html){
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalBack.classList.add("show");
}
function closeModal(){
  modalBack.classList.remove("show");
}
modalClose.addEventListener("click", closeModal);
modalBack.addEventListener("click", (e)=>{ if(e.target===modalBack) closeModal(); });

// ---------- password eye ----------
togglePass.addEventListener("click", () => {
  const isPw = passwordEl.type === "password";
  passwordEl.type = isPw ? "text" : "password";
  togglePass.textContent = isPw ? "🙈" : "👁";
});

// ---------- cooldown ----------
function cooldownSeconds(){ return isGuest ? 5 : 3; }
function canSend(){ return now() >= cooldownUntil; }

function startCooldown(){
  const secs = cooldownSeconds();
  cooldownUntil = now() + secs*1000;
  cooldownRow.style.display = "flex";
  updateCooldown();
}
function updateCooldown(){
  const msLeft = cooldownUntil - now();
  const total = cooldownSeconds()*1000;
  const p = clamp(1 - msLeft/total, 0, 1);
  cdFill.style.width = (p*100)+"%";

  if(msLeft <= 0){
    cooldownRow.style.display="none";
    cooldownRow.classList.remove("warn");
    return;
  }
  cooldownText.textContent = (msLeft/1000).toFixed(1)+"s";
  requestAnimationFrame(updateCooldown);
}
function cooldownWarn(){
  cooldownRow.style.display="flex";
  cooldownRow.classList.add("warn","shake");
  setTimeout(()=>cooldownRow.classList.remove("shake"), 380);
  setTimeout(()=>cooldownRow.classList.remove("warn"), 900);
}

// ---------- view switching ----------
function setView(type, id=null){
  view = { type, id };
  socket.emit("view:set", view);

  if(type==="global"){
    chatTitle.textContent="Global chat";
    chatHint.textContent="shared with everyone online";
    backBtn.style.display="none";
  } else if(type==="dm"){
    chatTitle.textContent=`DM — ${id}`;
    chatHint.textContent="private messages";
    backBtn.style.display="inline-flex";
  } else if(type==="group"){
    const meta = groupMeta.get(id);
    chatTitle.textContent = meta ? `Group — ${meta.name}` : "Group";
    chatHint.textContent="group chat";
    backBtn.style.display="inline-flex";
  }
}

backBtn.addEventListener("click", ()=> openGlobal(true));

// ---------- message rendering ----------
function fmtTime(ts){
  const d = new Date(ts);
  if(!Number.isFinite(d.getTime())) return null;
  const h = String(d.getHours()).padStart(2,"0");
  const m = String(d.getMinutes()).padStart(2,"0");
  return `${h}:${m}`;
}

function maybeHideMild(text){
  if (!settings?.hideMildProfanity) return text;
  return String(text).replace(MILD_RX, "•••");
}

function isBlockedUser(u){
  return !!social?.blocked?.includes(u);
}

function addMessageToUI({ user, text, ts }, { scope="global", from=null } = {}){
  const t = fmtTime(ts);
  if(!t) return;

  const who = scope==="dm" ? from : user;

  let bodyText = text;
  if(scope==="global"){
    if(isBlockedUser(who)){
      bodyText = "Message hidden (blocked user).";
    } else {
      bodyText = maybeHideMild(bodyText);
    }
  } else {
    // DM/group: mild filtering only if enabled
    bodyText = maybeHideMild(bodyText);
  }

  const row = document.createElement("div");
  row.className="msg";
  row.innerHTML = `
    <div class="bubble">
      <div class="meta">
        <div class="u" data-user="${escapeHtml(who)}">${escapeHtml(who)}${(who===me?" (You)":"")}</div>
        <div class="t">${t}</div>
      </div>
      <div class="body">${escapeHtml(bodyText)}</div>
    </div>
  `;

  // click username -> profile popup
  row.querySelector(".u").addEventListener("click", (e)=>{
    const u = e.target.getAttribute("data-user");
    openProfile(u);
  });

  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function clearChat(){ chatBox.innerHTML=""; }

// ---------- sidebars ----------
function renderSidebarGlobal(){
  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Online</div>
      <div style="font-size:11px;color:var(--muted)">${onlineUsers.length}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${onlineUsers.map(u => `
        <div class="row" data-profile="${escapeHtml(u.user)}">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u.user)}${u.user===me ? " (You)" : ""}</div>
              <div class="rowSub">click for profile</div>
            </div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
  sideSection.querySelectorAll("[data-profile]").forEach(el=>{
    el.addEventListener("click", ()=> openProfile(el.getAttribute("data-profile")));
  });
}

function renderSidebarMessages(){
  // list: DMs from cache + groups from groupMeta
  const dmUsers = Array.from(new Set(Array.from(dmCache.keys()))).sort((a,b)=>a.localeCompare(b));
  const groups = Array.from(groupMeta.values()).sort((a,b)=>a.name.localeCompare(b.name));

  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Messages</div>
      <button class="btn small" id="createGroupBtn">Create group</button>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="margin-top:6px;font-size:11px;color:var(--muted)">DMs</div>
      <div id="dmList" style="display:flex;flex-direction:column;gap:8px"></div>

      <div style="margin-top:10px;font-size:11px;color:var(--muted)">Groups</div>
      <div id="groupList" style="display:flex;flex-direction:column;gap:8px"></div>
    </div>
  `;

  const dmList = $("dmList");
  const groupList = $("groupList");

  dmUsers.forEach(u=>{
    const row = document.createElement("div");
    row.className="row";
    row.innerHTML = `
      <div class="rowLeft">
        <div class="statusDot ${onlineUsers.some(x=>x.user===u) ? "on":""}"></div>
        <div class="nameCol">
          <div class="rowName">${escapeHtml(u)}</div>
          <div class="rowSub">dm</div>
        </div>
      </div>
    `;
    row.addEventListener("click", ()=> openDM(u));
    dmList.appendChild(row);
  });

  groups.forEach(g=>{
    const row = document.createElement("div");
    row.className="row";
    row.innerHTML = `
      <div class="rowLeft">
        <div class="statusDot on"></div>
        <div class="nameCol">
          <div class="rowName">${escapeHtml(g.name)}</div>
          <div class="rowSub">${escapeHtml(g.id)}</div>
        </div>
      </div>
    `;
    row.addEventListener("click", ()=> openGroup(g.id));
    groupList.appendChild(row);
  });

  $("createGroupBtn").onclick = () => {
    if(isGuest){
      toast("Guests", "Guests can’t create groups. Log in to use groups.");
      return;
    }
    openModal("Create group", `
      <div style="display:flex;flex-direction:column;gap:10px">
        <div style="font-size:12px;color:var(--muted)">Group name</div>
        <input id="gcName" class="field" placeholder="e.g. ramen squad" />
        <button class="btn primary" id="gcCreate">Create</button>
      </div>
    `);
    setTimeout(()=> $("gcName")?.focus(), 40);
    $("gcCreate").onclick = () => {
      const name = $("gcName").value.trim();
      if(!name) return;
      closeModal();
      socket.emit("group:create", { name });
      toast("Group", "Creating…");
    };
  };
}

function renderSidebarInbox(){
  if(isGuest){
    sideSection.innerHTML = `
      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px;line-height:1.45">
        Guest mode has no inbox.
        <br><br>
        Log in to get friend requests.
      </div>
    `;
    return;
  }

  const incoming = social?.incoming || [];
  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Inbox</div>
      <div style="font-size:11px;color:var(--muted)">${incoming.length} requests</div>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
      ${incoming.length ? incoming.map(u=>`
        <div class="row">
          <div class="rowLeft">
            <div class="statusDot ${onlineUsers.some(x=>x.user===u)?"on":""}"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u)}</div>
              <div class="rowSub">friend request</div>
            </div>
          </div>
          <button class="btn small primary" data-accept="${escapeHtml(u)}">Accept</button>
        </div>
      `).join("") : `
        <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px">
          No friend requests right now.
        </div>
      `}
    </div>
  `;

  sideSection.querySelectorAll("[data-accept]").forEach(b=>{
    b.addEventListener("click", (e)=>{
      e.stopPropagation();
      socket.emit("friend:accept", { from: b.getAttribute("data-accept") });
      toast("Friends", "Accepted.");
    });
  });
}

// ---------- open global/dm/group ----------
function openGlobal(force){
  currentDM = null;
  currentGroupId = null;
  setView("global");

  tabGlobal.classList.add("primary");
  tabMessages.classList.remove("primary");
  tabInbox.classList.remove("primary");

  if(force){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, { scope:"global" }));
  }
  socket.emit("requestGlobalHistory");
  renderSidebarGlobal();
}

function openDM(user){
  if(isGuest){
    toast("Guests", "Guests can’t DM. Log in to use DMs.");
    return;
  }
  currentDM = user;
  currentGroupId = null;
  setView("dm", user);

  tabGlobal.classList.remove("primary");
  tabMessages.classList.add("primary");
  tabInbox.classList.remove("primary");

  clearChat();
  socket.emit("dm:history", { withUser: user });
  renderSidebarMessages();
}

function openGroup(gid){
  if(isGuest) return;
  currentGroupId = gid;
  currentDM = null;
  setView("group", gid);

  tabGlobal.classList.remove("primary");
  tabMessages.classList.add("primary");
  tabInbox.classList.remove("primary");

  clearChat();
  socket.emit("group:history", { groupId: gid });
  renderSidebarMessages();
}

// ---------- group management popup ----------
function openGroupManage(gid){
  const meta = groupMeta.get(gid);
  if(!meta) return;

  const isOwner = meta.owner === me;

  const membersHtml = meta.members.map(u => `
    <div class="row" data-member="${escapeHtml(u)}" title="Right-click your own name to leave">
      <div class="rowLeft">
        <div class="statusDot ${onlineUsers.some(x=>x.user===u)?"on":""}"></div>
        <div class="nameCol">
          <div class="rowName">${escapeHtml(u)}${u===meta.owner ? " (Owner)" : ""}${u===me ? " (You)" : ""}</div>
          <div class="rowSub">member</div>
        </div>
      </div>

      ${isOwner && u!==meta.owner ? `<button class="btn small" data-remove="${escapeHtml(u)}">Remove</button>` : ``}
    </div>
  `).join("");

  openModal("Group settings", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
        <div>
          <div style="font-weight:950">${escapeHtml(meta.name)}</div>
          <div style="font-size:12px;color:var(--muted)">${escapeHtml(meta.id)}</div>
        </div>
        <button class="btn small" id="closeG">Close</button>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Members</div>
        <div style="display:flex;flex-direction:column;gap:8px" id="membersList">${membersHtml}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:10px">
          Tip: Right-click your own name to leave the group.
        </div>
      </div>

      ${isOwner ? `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="font-weight:900;font-size:12px">Owner controls</div>
          <div style="display:flex;gap:10px">
            <input id="addUser" class="field" placeholder="Add member (username)" />
            <button class="btn small primary" id="addBtn">Add</button>
          </div>

          <div style="display:flex;gap:10px">
            <input id="transferUser" class="field" placeholder="Transfer ownership to…" />
            <button class="btn small" id="transferBtn">Transfer</button>
          </div>

          <button class="btn" id="deleteBtn" style="border-color:rgba(255,77,77,.35)">Delete group</button>
        </div>
      ` : `
        <button class="btn" id="leaveBtn" style="border-color:rgba(255,77,77,.35)">Leave group</button>
      `}
    </div>
  `);

  $("closeG").onclick = closeModal;

  // Remove member (owner)
  modalBody.querySelectorAll("[data-remove]").forEach(btn=>{
    btn.addEventListener("click",(e)=>{
      e.stopPropagation();
      const u = btn.getAttribute("data-remove");
      socket.emit("group:removeMember", { groupId: gid, user: u });
      toast("Group", `Removing ${u}…`);
    });
  });

  // Right click your own name -> leave
  modalBody.querySelectorAll("[data-member]").forEach(row=>{
    row.addEventListener("contextmenu",(e)=>{
      e.preventDefault();
      const u = row.getAttribute("data-member");
      if(u !== me) return;

      // popup confirm (still no alert)
      openModal("Leave group?", `
        <div style="color:var(--muted);font-size:12px;line-height:1.45">
          Leave <b>${escapeHtml(meta.name)}</b>? You can be re-added by the owner.
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn" id="cancelLeave">Cancel</button>
          <button class="btn primary" id="confirmLeave">Leave</button>
        </div>
      `);
      $("cancelLeave").onclick = ()=> openGroupManage(gid);
      $("confirmLeave").onclick = ()=>{
        closeModal();
        socket.emit("group:leave", { groupId: gid });
        toast("Group", "Leaving…");
      };
    });
  });

  if(isOwner){
    $("addBtn").onclick = ()=>{
      const u = $("addUser").value.trim();
      if(!u) return;
      socket.emit("group:addMember", { groupId: gid, user: u });
      toast("Group", `Adding ${u}…`);
    };
    $("transferBtn").onclick = ()=>{
      const u = $("transferUser").value.trim();
      if(!u) return;
      socket.emit("group:transferOwner", { groupId: gid, newOwner: u });
      toast("Group", `Transferring to ${u}…`);
    };
    $("deleteBtn").onclick = ()=>{
      openModal("Delete group?", `
        <div style="color:var(--muted);font-size:12px;line-height:1.45">
          Delete <b>${escapeHtml(meta.name)}</b>? This can’t be undone.
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn" id="cancelDel">Cancel</button>
          <button class="btn primary" id="confirmDel">Delete</button>
        </div>
      `);
      $("cancelDel").onclick = ()=> openGroupManage(gid);
      $("confirmDel").onclick = ()=>{
        closeModal();
        socket.emit("group:delete", { groupId: gid });
        toast("Group", "Deleting…");
      };
    };
  } else {
    $("leaveBtn").onclick = ()=>{
      socket.emit("group:leave", { groupId: gid });
      closeModal();
      toast("Group", "Leaving…");
    };
  }
}

// ---------- profile popup ----------
function openProfile(user){
  if(!user) return;
  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div>
          <div style="font-weight:950;font-size:16px">${escapeHtml(user)}</div>
          <div style="font-size:12px;color:var(--muted)" id="profSub">loading…</div>
        </div>
        <button class="btn small" id="profClose">Close</button>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap" id="profActions"></div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Stats</div>
        <div id="profStats" style="display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px"></div>
      </div>

      <div style="display:flex;gap:10px">
        ${(!isGuest && user !== me && !isGuestUser(user)) ? `<button class="btn" id="dmBtn">DM</button>` : ``}
        ${(!isGuest && user !== me && !isGuestUser(user)) ? `<button class="btn" id="friendBtn">Add friend</button>` : ``}
        ${(!isGuest && user !== me && !isGuestUser(user)) ? `<button class="btn" id="blockBtn">Block</button>` : ``}
      </div>
    </div>
  `);

  $("profClose").onclick = closeModal;

  socket.emit("profile:get", { user });

  // Hook buttons after data arrives
  modalBody._profileUser = user;
}

function isGuestUser(u){ return /^Guest\d{1,10}$/.test(String(u)); }

// ---------- settings popup ----------
function openSettings(){
  if(isGuest){
    openModal("Settings (Guest)", `
      <div style="color:var(--muted);font-size:12px;line-height:1.45">
        Guest settings aren’t saved. Log in to save themes/layout and use friends/groups.
      </div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn primary" id="closeS">Close</button>
      </div>
    `);
    $("closeS").onclick = closeModal;
    return;
  }

  const s = settings || {};
  const theme = s.theme || "dark";
  const density = Number.isFinite(s.density) ? s.density : 0.55;

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:10px">

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Theme</div>
        <input id="themeSlider" type="range" min="0" max="3" step="1" value="${["dark","vortex","abyss","carbon"].indexOf(theme)}" style="width:100%">
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Current: <b id="themeName">${escapeHtml(theme)}</b></div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Layout density</div>
        <input id="densitySlider" type="range" min="0" max="1" step="0.01" value="${density}" style="width:100%">
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Compact ↔ Cozy</div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:900;font-size:12px">Hide mild profanity</div>
            <div style="font-size:11px;color:var(--muted)">F/S/A words etc get masked as •••.</div>
          </div>
          <button class="btn small" id="toggleMild">${settings?.hideMildProfanity ? "On" : "Off"}</button>
        </div>
      </div>

      <div style="display:flex;gap:10px">
        <button class="btn primary" id="saveS">Save</button>
        <button class="btn" id="closeS">Close</button>
      </div>
    </div>
  `);

  $("closeS").onclick = closeModal;

  const themeKeys = ["dark","vortex","abyss","carbon"];
  $("themeSlider").addEventListener("input", ()=>{
    const k = themeKeys[Number($("themeSlider").value)];
    $("themeName").textContent = k;
    applyTheme(k);
  });

  $("densitySlider").addEventListener("input", ()=>{
    applyDensity($("densitySlider").value);
  });

  $("toggleMild").onclick = ()=>{
    settings.hideMildProfanity = !settings.hideMildProfanity;
    $("toggleMild").textContent = settings.hideMildProfanity ? "On" : "Off";
  };

  $("saveS").onclick = ()=>{
    const k = themeKeys[Number($("themeSlider").value)];
    const d = Number($("densitySlider").value);

    settings.theme = k;
    settings.density = d;

    socket.emit("settings:update", settings);
    toast("Settings", "Saved.");
    closeModal();
  };
}

// ---------- tabs ----------
tabGlobal.addEventListener("click", ()=> openGlobal(true));
tabMessages.addEventListener("click", ()=>{
  tabGlobal.classList.remove("primary");
  tabMessages.classList.add("primary");
  tabInbox.classList.remove("primary");
  renderSidebarMessages();
});
tabInbox.addEventListener("click", ()=>{
  tabGlobal.classList.remove("primary");
  tabMessages.classList.remove("primary");
  tabInbox.classList.add("primary");
  renderSidebarInbox();
});

// ---------- composer send ----------
sendBtn.addEventListener("click", sendCurrent);
messageEl.addEventListener("keydown", (e)=>{
  if(e.key==="Enter" && !e.shiftKey){
    e.preventDefault();
    sendCurrent();
  }
});

function sendCurrent(){
  if(!me) return;
  if(!canSend()){ cooldownWarn(); return; }

  const text = messageEl.value.trim();
  if(!text) return;

  startCooldown();
  messageEl.value = "";

  if(view.type==="global"){
    socket.emit("sendGlobal", { text, ts: now() });
  } else if(view.type==="dm"){
    socket.emit("dm:send", { to: currentDM, text });
  } else if(view.type==="group"){
    socket.emit("group:send", { groupId: currentGroupId, text });
  }
}

// ---------- auth buttons ----------
settingsBtn.addEventListener("click", openSettings);

logoutBtn.addEventListener("click", ()=>{
  showLoading("logging out…");
  setTimeout(()=>{
    localStorage.removeItem("tonkotsu_token");
    location.reload();
  }, 650);
});

loginBtn.addEventListener("click", ()=>{
  loginOverlay.classList.remove("hidden");
});

// ---------- join buttons ----------
function shakeLogin(){
  const card = document.querySelector(".loginCard");
  card.classList.add("shake");
  setTimeout(()=> card.classList.remove("shake"), 380);
}

joinBtn.addEventListener("click", ()=>{
  const u = usernameEl.value.trim();
  const p = passwordEl.value;

  // join does NOTHING if missing
  if(!u || !p){
    shakeLogin();
    return;
  }

  showLoading("logging in…");
  socket.emit("login", { username: u, password: p, guest:false });
});

guestBtn.addEventListener("click", ()=>{
  showLoading("joining as guest…");
  socket.emit("login", { guest:true });
});

passwordEl.addEventListener("keydown",(e)=>{
  if(e.key==="Enter") joinBtn.click();
});

// ---------- socket events ----------
socket.on("loginSuccess",(data)=>{
  hideLoading();

  me = data.username;
  isGuest = !!data.guest;
  settings = data.settings || settings;
  social = data.social || social;
  xp = data.xp || xp;

  // apply theme/layout immediately
  applyTheme(settings?.theme || "dark");
  applyDensity(settings?.density ?? 0.55);

  // show app properly (fix overlap)
  loginOverlay.classList.add("hidden");
  app.classList.add("show");
  mePill.style.display = "flex";
  meName.textContent = me;

  if(!isGuest && data.token){
    localStorage.setItem("tonkotsu_token", data.token);
    token = data.token;
  }

  if(isGuest){
    // guest limitations
    settingsBtn.style.display="none";
    logoutBtn.style.display="none";
    loginBtn.style.display="inline-flex";

    const warned = localStorage.getItem("tonkotsu_beta_warned");
    if(!warned){
      toast("Beta", "Guest mode is limited. DM fishy_x1 on Discord for suggestions/issues.");
      localStorage.setItem("tonkotsu_beta_warned","1");
    }
  } else {
    settingsBtn.style.display="inline-flex";
    logoutBtn.style.display="inline-flex";
    loginBtn.style.display="none";
  }

  toast("Welcome", isGuest ? "Joined as Guest" : `Logged in as ${me}`);

  // default start global
  openGlobal(true);
});

socket.on("resumeFail", ()=>{
  localStorage.removeItem("tonkotsu_token");
  token = null;
});

socket.on("loginError",(msg)=>{
  hideLoading();
  shakeLogin();
  toast("Login failed", msg || "Try again.");
});

socket.on("settings",(s)=>{
  settings = s;
  applyTheme(settings?.theme || "dark");
  applyDensity(settings?.density ?? 0.55);
});

socket.on("social:update",(s)=>{
  social = s;
  if(tabInbox.classList.contains("primary")) renderSidebarInbox();
});

socket.on("xp:update",(x)=>{
  xp = x;
});

socket.on("onlineUsers",(list)=>{
  onlineUsers = Array.isArray(list) ? list : [];
  if(view.type==="global") renderSidebarGlobal();
});

socket.on("history",(msgs)=>{
  globalCache = (Array.isArray(msgs)?msgs:[])
    .filter(m => Number.isFinite(new Date(m.ts).getTime()));
  if(view.type==="global"){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, { scope:"global" }));
  }
});

socket.on("globalMessage",(m)=>{
  if(!m || !Number.isFinite(new Date(m.ts).getTime())) return;
  globalCache.push(m);
  if(view.type==="global"){
    addMessageToUI(m, { scope:"global" });
  }
});

socket.on("sendError",(e)=>{
  toast("Action blocked", e?.reason || "Blocked.");
});

socket.on("groups:list",(list)=>{
  // list: [{id,name,owner,members}]
  if(isGuest) return;

  groupMeta.clear();
  (Array.isArray(list)?list:[]).forEach(g=>{
    groupMeta.set(g.id, { id:g.id, name:g.name, owner:g.owner, members:[] });
  });

  if(tabMessages.classList.contains("primary")) renderSidebarMessages();
});

socket.on("group:created",(g)=>{
  if(!g) return;
  groupMeta.set(g.id, { id:g.id, name:g.name, owner:g.owner, members:[] });
  toast("Group", `Created “${g.name}”`);
  socket.emit("groups:list");
});

socket.on("group:history",({ groupId, meta, msgs })=>{
  groupMeta.set(groupId, meta);
  groupCache.set(groupId, msgs || []);
  currentGroupId = groupId;

  setView("group", groupId);

  clearChat();
  (msgs || []).forEach(m=> addMessageToUI(m, { scope:"group" }));

  // group header action: manage button (popup)
  chatHint.innerHTML = `members: <b style="color:var(--text)">${meta.members.length}</b> • <span style="text-decoration:underline;cursor:pointer" id="manageGroupLink">manage</span>`;
  setTimeout(()=>{
    const link = document.getElementById("manageGroupLink");
    if(link) link.onclick = ()=> openGroupManage(groupId);
  }, 0);
});

socket.on("group:message",({ groupId, msg })=>{
  if(!groupCache.has(groupId)) groupCache.set(groupId, []);
  groupCache.get(groupId).push(msg);

  if(view.type==="group" && currentGroupId===groupId){
    addMessageToUI(msg, { scope:"group" });
  }
});

socket.on("group:meta",({ groupId, name, owner, members })=>{
  const m = groupMeta.get(groupId) || { id: groupId, name: name || groupId, owner: owner || "—", members: members || [] };
  m.name = name ?? m.name;
  m.owner = owner ?? m.owner;
  if(Array.isArray(members)) m.members = members;
  groupMeta.set(groupId, m);

  if(view.type==="group" && currentGroupId===groupId){
    chatTitle.textContent = `Group — ${m.name}`;
  }
});

socket.on("group:left",({ groupId })=>{
  toast("Group",
