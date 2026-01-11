/* tonkotsu.online — client script (NO alerts, only popups)
   Fixes:
   - No self add button
   - Global click doesn't clear messages
   - Emoji picker scrollable
   - Cooldown timer + shake + red flash (3s normal, 5s guest)
   - Guest beta warning once, per browser
   - Auto re-login on refresh (non-guest)
*/

const socket = io();

const $ = (id) => document.getElementById(id);

const loginOverlay = $("loginOverlay");
const loading = $("loading");
const app = $("app");

const usernameEl = $("username");
const passwordEl = $("password");
const joinBtn = $("joinBtn");
const guestBtn = $("guestBtn");

const tabGlobal = $("tabGlobal");
const tabMessages = $("tabMessages");
const tabInbox = $("tabInbox");

const sideSection = $("sideSection");

const mePill = $("mePill");
const meName = $("meName");

const settingsBtn = $("settingsBtn");
const logoutBtn = $("logoutBtn");
const loginBtn = $("loginBtn");

const chatTitle = $("chatTitle");
const chatHint = $("chatHint");
const viewPill = $("viewPill");
const chatBox = $("chatBox");

const messageEl = $("message");
const sendBtn = $("sendBtn");

const cooldownRow = $("cooldownRow");
const cooldownText = $("cooldownText");
const cdFill = $("cdFill");

const modalBack = $("modalBack");
const modal = $("modal");
const modalTitle = $("modalTitle");
const modalBody = $("modalBody");
const modalFoot = $("modalFoot");
const modalClose = $("modalClose");

const emojiToggle = $("emojiToggle");
const emojiPicker = $("emojiPicker");
const emojiGrid = $("emojiGrid");
const emojiSearch = $("emojiSearch");

$("year").textContent = new Date().getFullYear();

/* ---------- app state ---------- */
let me = null;
let isGuest = false;
let myColor = null;

let activeView = "global"; // global | dm | group
let activeTarget = null;   // username or groupId

let globalCache = []; // keeps current global messages so tabs don't wipe
let dmCache = new Map();   // key => messages
let groupCache = new Map();// groupId => messages

let onlineUsers = []; // [{user,color,guest}]
let messagesList = []; // list of DMs + groups entries (from server state)
let inboxItems = [];   // friend requests / group invites

let lastSentAt = 0;
let cooldownMs = 3000;
let cooldownTimer = null;

/* ---------- local session memory ---------- */
const LS = {
  session: "tk_session",                 // stores non-guest login
  guestWarned: "tk_guest_warned_once",   // show big warning once per browser
  guestWarnedAt: "tk_guest_warned_at"
};

function saveSession(user, pass){
  // store only to auto-login; server enforces password anyway
  localStorage.setItem(LS.session, JSON.stringify({ user, pass }));
}
function clearSession(){
  localStorage.removeItem(LS.session);
}
function loadSession(){
  try{
    const raw = localStorage.getItem(LS.session);
    if(!raw) return null;
    const obj = JSON.parse(raw);
    if(!obj?.user || !obj?.pass) return null;
    return obj;
  }catch{return null;}
}
function hasShownGuestWarning(){
  return localStorage.getItem(LS.guestWarned) === "1";
}
function markGuestWarningShown(){
  localStorage.setItem(LS.guestWarned, "1");
  localStorage.setItem(LS.guestWarnedAt, String(Date.now()));
}

/* ---------- NO ALERTS: popup modal ---------- */
function openModal(title, html, footButtons = null){
  modalTitle.textContent = title;
  modalBody.innerHTML = html || "";
  if(footButtons && footButtons.length){
    modalFoot.style.display = "flex";
    modalFoot.innerHTML = "";
    for(const b of footButtons){
      const btn = document.createElement("button");
      btn.className = "btn" + (b.primary ? " primary" : "");
      btn.textContent = b.label;
      btn.onclick = () => b.onClick?.();
      modalFoot.appendChild(btn);
    }
  }else{
    modalFoot.style.display = "none";
    modalFoot.innerHTML = "";
  }
  modalBack.classList.add("show");
}
function closeModal(){
  modalBack.classList.remove("show");
  modalBody.innerHTML = "";
  modalFoot.innerHTML = "";
  modalFoot.style.display = "none";
}
modalClose.onclick = closeModal;
modalBack.addEventListener("click", (e)=>{
  if(e.target === modalBack) closeModal();
});

/* ---------- helpers ---------- */
function escapeHTML(s){
  return String(s).replace(/[&<>"']/g, (c)=>({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function fmtTime(ts){
  const d = new Date(ts);
  if(Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}
function scrollToBottom(){
  chatBox.scrollTop = chatBox.scrollHeight;
}
function setLoading(show, sub="syncing…"){
  $("loaderSub").textContent = sub;
  if(show) loading.classList.add("show");
  else loading.classList.remove("show");
}
function showLogin(){
  loginOverlay.classList.remove("hidden");
  app.classList.remove("ready");
}
function showApp(){
  loginOverlay.classList.add("hidden");
  requestAnimationFrame(()=> app.classList.add("ready"));
}

/* ---------- cooldown UI (timer + shake + red flash) ---------- */
function setCooldown(seconds){
  cooldownMs = Math.max(0, Math.floor(seconds*1000));
}
function canSendNow(){
  return Date.now() - lastSentAt >= cooldownMs;
}
function startCooldownTicker(){
  if(cooldownMs <= 0) return;
  cooldownRow.style.display = "flex";
  clearInterval(cooldownTimer);
  cooldownTimer = setInterval(()=>{
    const left = Math.max(0, cooldownMs - (Date.now() - lastSentAt));
    const pct = (1 - (left / cooldownMs)) * 100;
    cdFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    cooldownText.textContent = `${(left/1000).toFixed(1)}s`;
    if(left <= 0){
      cooldownText.textContent = "0.0s";
      cdFill.style.width = "100%";
      // keep bar visible but calm
      cooldownRow.classList.remove("warn");
    }
  }, 80);
}
function warnCooldown(){
  cooldownRow.classList.add("warn");
  cooldownRow.classList.remove("shake");
  void cooldownRow.offsetWidth;
  cooldownRow.classList.add("shake");

  // fade red back to normal
  setTimeout(()=> cooldownRow.classList.remove("warn"), 650);
}

/* ---------- emoji picker ---------- */
const EMOJIS = [
  "😀","😁","😂","🤣","😅","😊","😍","😘","😎","🤝","👍","👎","🔥","💯","✨","🖤",
  "😡","😭","🙏","🎉","🤔","😴","🤯","🥶","🥵","🤫","😈","👀","💀","🤍","✅","⚠️",
  "🍜","🍣","🍙","🍱","🍔","🍟","🍕","🍩","🍪","🍫","☕","🧃","🥤","🎧","🎮","💎",
  "🗿","🧠","🧩","📌","📎","📣","🔔","🔒","🛡️","🚀","🌙","⭐","🌸","🌊","🎲","🧸"
];

function renderEmojis(filter=""){
  const f = filter.trim().toLowerCase();
  emojiGrid.innerHTML = "";
  for(const e of EMOJIS){
    // simple search by emoji name is not available; we only filter empty for now
    // but still keep UI consistent
    if(f && !e.includes(f)) continue;

    const b = document.createElement("button");
    b.className = "emojiBtn";
    b.type = "button";
    b.textContent = e;
    b.onclick = ()=>{
      messageEl.value += e;
      closeEmoji();
      messageEl.focus();
    };
    emojiGrid.appendChild(b);
  }
}
function openEmoji(){
  emojiPicker.classList.add("show");
}
function closeEmoji(){
  emojiPicker.classList.remove("show");
  emojiSearch.value = "";
  renderEmojis("");
}
emojiToggle.onclick = (e)=>{
  e.stopPropagation();
  if(emojiPicker.classList.contains("show")) closeEmoji();
  else openEmoji();
};
emojiSearch.addEventListener("input", ()=> renderEmojis(emojiSearch.value));
document.addEventListener("click", (e)=>{
  if(!emojiPicker.contains(e.target) && e.target !== emojiToggle) closeEmoji();
});
renderEmojis("");

/* ---------- sidebar rendering ---------- */
function setActiveTab(btn){
  [tabGlobal, tabMessages, tabInbox].forEach(x=>x.classList.remove("primary"));
  btn.classList.add("primary");
}

function renderGlobalSidebar(){
  setActiveTab(tabGlobal);

  // Online users card
  const list = onlineUsers
    .filter(u=> u.user) // no empty
    .sort((a,b)=>a.user.localeCompare(b.user));

  const items = list.map(u=>{
    const you = (u.user === me);
    // NO add/friend on yourself
    const action = you ? "" : (!isGuest ? `<button class="btn small" data-fr="${escapeHTML(u.user)}">Add</button>` : "");
    return `
      <div class="row" data-open-user="${escapeHTML(u.user)}" title="Open user">
        <div class="rowLeft">
          <div class="statusDot on"></div>
          <div class="nameCol">
            <div class="rowName">${escapeHTML(u.user)}${you ? " (You)" : ""}</div>
            <div class="rowSub">${u.guest ? "guest" : "account"}</div>
          </div>
        </div>
        <div class="rowRight">${action}</div>
      </div>
    `;
  }).join("");

  sideSection.innerHTML = `
    <div class="card">
      <div class="listTitle">
        <h3>Online</h3>
        <span style="font-size:11px;color:var(--muted)">${list.length}</span>
      </div>
      <div class="list" id="onlineList">${items || `<div style="color:var(--muted);font-size:12px;padding:8px">No one online</div>`}</div>
    </div>
  `;

  // attach add buttons
  sideSection.querySelectorAll("[data-fr]").forEach(btn=>{
    btn.addEventListener("click",(e)=>{
      e.stopPropagation();
      const target = btn.getAttribute("data-fr");
      openModal("Send friend request", `
        <div style="color:var(--muted);font-size:12px;line-height:1.45">
          Send a friend request to <b style="color:#e9eff7">${escapeHTML(target)}</b>?
        </div>
      `, [
        {label:"Cancel", onClick: closeModal},
        {label:"Send", primary:true, onClick: ()=>{
          closeModal();
          socket.emit("sendFriendRequest", { user: target });
        }}
      ]);
    });
  });
}

function renderMessagesSidebar(){
  setActiveTab(tabMessages);

  // "Create group" lives here (no owner-only label)
  const createBtn = (!isGuest) ? `
    <button class="btn small primary" id="createGroupBtn">Create group</button>
  ` : "";

  const rows = messagesList.map(item=>{
    const isActive = (activeView === item.type && activeTarget === item.id);
    const ping = item.unread > 0 ? `<span class="ping show">${item.unread}</span>` : `<span class="ping">0</span>`;
    const sub = item.type === "dm" ? "direct message" : "group chat";
    return `
      <div class="row ${isActive ? "active" : ""}" data-open="${item.type}:${escapeHTML(item.id)}">
        <div class="rowLeft">
          <div class="statusDot ${item.online ? "on" : ""}"></div>
          <div class="nameCol">
            <div class="rowName">${escapeHTML(item.name)}</div>
            <div class="rowSub">${sub}</div>
          </div>
        </div>
        <div class="rowRight">${ping}</div>
      </div>
    `;
  }).join("");

  sideSection.innerHTML = `
    <div class="card">
      <div class="listTitle">
        <h3>Messages</h3>
        ${createBtn}
      </div>
      <div class="list" id="msgList">
        ${rows || `<div style="color:var(--muted);font-size:12px;padding:8px">No DMs/groups yet</div>`}
      </div>
    </div>
  `;

  // open message
  sideSection.querySelectorAll("[data-open]").forEach(row=>{
    row.addEventListener("click", ()=>{
      const val = row.getAttribute("data-open");
      const [type, id] = val.split(":");
      if(type === "dm") openDM(id);
      if(type === "group") openGroup(id);
    });
  });

  // create group popup (NO ALERT)
  const cg = $("createGroupBtn");
  if(cg){
    cg.onclick = ()=>{
      openModal("Create group", `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="color:var(--muted);font-size:12px;line-height:1.45">
            Pick a name and invite friends. (You must already be friends.)
          </div>
          <input id="gcName" class="field" placeholder="Group name" />
          <div style="color:var(--muted);font-size:12px;margin-top:2px">Invite (comma-separated usernames):</div>
          <input id="gcInvites" class="field" placeholder="user1, user2, user3" />
        </div>
      `, [
        {label:"Cancel", onClick: closeModal},
        {label:"Create", primary:true, onClick: ()=>{
          const name = document.getElementById("gcName").value.trim();
          const raw = document.getElementById("gcInvites").value.trim();
          const invites = raw ? raw.split(",").map(x=>x.trim()).filter(Boolean) : [];
          closeModal();
          socket.emit("createGroup", { name, invites });
        }}
      ]);
    };
  }
}

function renderInboxSidebar(){
  setActiveTab(tabInbox);

  if(isGuest){
    sideSection.innerHTML = `
      <div class="card">
        <div class="listTitle"><h3>Inbox</h3></div>
        <div style="color:var(--muted);font-size:12px;line-height:1.45;padding:8px">
          Guests don’t have inbox/friends/groups.
        </div>
      </div>
    `;
    return;
  }

  const rows = inboxItems.map(it=>{
    const title = it.type === "friend" ? `Friend request` : `Group invite`;
    const from = it.from ? escapeHTML(it.from) : "";
    const group = it.groupName ? escapeHTML(it.groupName) : "";
    const line = it.type === "friend"
      ? `<b style="color:#e9eff7">${from}</b> wants to add you.`
      : `<b style="color:#e9eff7">${from}</b> invited you to <b style="color:#e9eff7">${group}</b>.`;

    const buttons = it.type === "friend"
      ? `
        <button class="btn small primary" data-accept="${escapeHTML(it.from)}">Accept</button>
        <button class="btn small" data-decline="${escapeHTML(it.from)}">Decline</button>
      `
      : `
        <button class="btn small primary" data-gaccept="${escapeHTML(it.groupId)}">Join</button>
        <button class="btn small" data-gdecline="${escapeHTML(it.groupId)}">Decline</button>
      `;

    return `
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:900;font-size:12px">${title}</div>
            <div style="color:var(--muted);font-size:12px;margin-top:4px;line-height:1.35">${line}</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">${buttons}</div>
        </div>
      </div>
    `;
  }).join("");

  sideSection.innerHTML = `
    <div class="card">
      <div class="listTitle"><h3>Inbox</h3></div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
        ${rows || `<div style="color:var(--muted);font-size:12px;padding:8px">No notifications</div>`}
      </div>
    </div>
  `;

  sideSection.querySelectorAll("[data-accept]").forEach(b=>{
    b.onclick = ()=>{
      socket.emit("acceptFriend", { user: b.getAttribute("data-accept") });
    };
  });
  sideSection.querySelectorAll("[data-decline]").forEach(b=>{
    b.onclick = ()=>{
      socket.emit("declineFriend", { user: b.getAttribute("data-decline") });
    };
  });
  sideSection.querySelectorAll("[data-gaccept]").forEach(b=>{
    b.onclick = ()=>{
      socket.emit("acceptGroupInvite", { groupId: b.getAttribute("data-gaccept") });
    };
  });
  sideSection.querySelectorAll("[data-gdecline]").forEach(b=>{
    b.onclick = ()=>{
      socket.emit("declineGroupInvite", { groupId: b.getAttribute("data-gdecline") });
    };
  });
}

function refreshSidebar(){
  if(activeView === "global") renderGlobalSidebar();
  else if(activeView === "dm" || activeView === "group") renderMessagesSidebar();
  else renderGlobalSidebar();
}

/* ---------- view switching (prevents global clearing) ---------- */
function openGlobal(){
  activeView = "global";
  activeTarget = null;
  viewPill.textContent = "global";
  chatTitle.textContent = "Global chat";
  chatHint.textContent = "shared with everyone online";

  // IMPORTANT: do NOT clear global messages if already cached
  renderMessages(globalCache, "global");
  renderGlobalSidebar();

  // only ask server for history if cache empty
  if(globalCache.length === 0){
    socket.emit("requestGlobalHistory");
  }
}

function openDM(user){
  if(isGuest){
    openModal("DMs are locked", `
      <div style="color:var(--muted);font-size:12px;line-height:1.45">
        Guests can’t use DMs. Log in with a username + password to unlock messaging.
      </div>
    `, [{label:"Close", primary:true, onClick: closeModal}]);
    return;
  }
  activeView = "dm";
  activeTarget = user;
  viewPill.textContent = "dm";
  chatTitle.textContent = `DM with ${user}`;
  chatHint.textContent = "private";

  renderMessagesSidebar();

  const key = `dm:${user}`;
  const cached = dmCache.get(key) || [];
  renderMessages(cached, "dm");

  socket.emit("openDM", { withUser: user });
}

function openGroup(groupId){
  if(isGuest){
    openModal("Groups are locked", `
      <div style="color:var(--muted);font-size:12px;line-height:1.45">
        Guests can’t use group chats. Log in to unlock groups.
      </div>
    `, [{label:"Close", primary:true, onClick: closeModal}]);
    return;
  }
  activeView = "group";
  activeTarget = groupId;
  viewPill.textContent = "group";
  chatTitle.textContent = "Group chat";
  chatHint.textContent = "members only";

  renderMessagesSidebar();

  const cached = groupCache.get(groupId) || [];
  renderMessages(cached, "group");

  socket.emit("openGroup", { groupId });
}

/* ---------- message rendering ---------- */
function renderMessages(list, type){
  chatBox.innerHTML = "";

  // remove messages with invalid timestamps (your request)
  const filtered = (list || []).filter(m=>{
    if(!m?.ts) return false;
    const t = fmtTime(m.ts);
    return !!t;
  });

  for(const m of filtered){
    const time = fmtTime(m.ts);
    const user = m.user || m.from || "unknown";
    const color = m.color || m.colors?.[user] || "#e8edf3";

    const el = document.createElement("div");
    el.className = "msg";
    el.innerHTML = `
      <div class="avatar" style="border-color: rgba(255,255,255,.10)">
        <div style="position:absolute;inset:0;background:${escapeHTML(color)};opacity:.12"></div>
      </div>
      <div class="bubble">
        <div class="meta">
          <div class="u" style="color:${escapeHTML(color)}">${escapeHTML(user)}</div>
          <div class="t">${escapeHTML(time)}</div>
        </div>
        <div class="body">${escapeHTML(m.text || "")}</div>
      </div>
    `;
    chatBox.appendChild(el);
  }

  scrollToBottom();
}

/* ---------- login / logout ---------- */
function doLogin(user, pass){
  socket.emit("login", { user, pass });
}
function doGuest(){
  socket.emit("login", { user:"", pass:"" }); // server makes guest if blank/blank
}

joinBtn.onclick = ()=>{
  const u = usernameEl.value.trim();
  const p = passwordEl.value;
  doLogin(u, p);
};
guestBtn.onclick = ()=>{
  doGuest();
};

logoutBtn.onclick = ()=>{
  // clean UI, keep data on server
  setLoading(true, "logging out…");
  setTimeout(()=>{
    clearSession();
    location.reload();
  }, 450);
};

loginBtn.onclick = ()=>{
  // show login overlay
  showLogin();
};

/* ---------- tabs ---------- */
tabGlobal.onclick = ()=>{
  // IMPORTANT: if already in global, do NOT wipe anything.
  if(activeView !== "global") openGlobal();
  else {
    // just make sure sidebar is correct
    renderGlobalSidebar();
    setActiveTab(tabGlobal);
  }
};

tabMessages.onclick = ()=>{
  if(isGuest){
    openModal("Messages locked", `
      <div style="color:var(--muted);font-size:12px;line-height:1.45">
        Guests can only use Global. Log in with a username + password to unlock DMs & groups.
      </div>
    `, [{label:"Close", primary:true, onClick: closeModal}]);
    return;
  }
  setActiveTab(tabMessages);
  renderMessagesSidebar();
};

tabInbox.onclick = ()=>{
  setActiveTab(tabInbox);
  renderInboxSidebar();
};

/* ---------- settings popup (small + real) ---------- */
settingsBtn.onclick = ()=>{
  if(isGuest){
    openModal("Guest settings", `
      <div style="color:var(--muted);font-size:12px;line-height:1.45">
        Guests have limited settings. Log in to unlock more.
      </div>
      <div style="margin-top:10px;display:flex;flex-direction:column;gap:10px">
        <div class="card">
          <div style="font-weight:900;font-size:12px">Reduce animations</div>
          <div style="color:var(--muted);font-size:12px;margin-top:6px">
            Helps on low-end devices.
          </div>
          <div style="margin-top:10px;display:flex;gap:10px">
            <button class="btn small" id="rmOn">On</button>
            <button class="btn small primary" id="rmOff">Off</button>
          </div>
        </div>
      </div>
    `);
    setTimeout(()=>{
      const rmOn = document.getElementById("rmOn");
      const rmOff = document.getElementById("rmOff");
      rmOn.onclick = ()=> document.body.classList.add("reduceMotion");
      rmOff.onclick = ()=> document.body.classList.remove("reduceMotion");
    }, 0);
    return;
  }

  openModal("Settings", `
    <div class="card">
      <div style="font-weight:900;font-size:12px">Reduce animations</div>
      <div style="color:var(--muted);font-size:12px;margin-top:6px">Less motion, more static UI.</div>
      <div style="margin-top:10px;display:flex;gap:10px">
        <button class="btn small" id="rmOn">On</button>
        <button class="btn small primary" id="rmOff">Off</button>
      </div>
    </div>

    <div class="card">
      <div style="font-weight:900;font-size:12px">Custom cursor</div>
      <div style="color:var(--muted);font-size:12px;margin-top:6px">Hide cursor + short fast trail.</div>
      <div style="margin-top:10px;display:flex;gap:10px">
        <button class="btn small" id="curOn">On</button>
        <button class="btn small primary" id="curOff">Off</button>
      </div>
    </div>

    <div class="card">
      <div style="font-weight:900;font-size:12px">Mute all sounds</div>
      <div style="color:var(--muted);font-size:12px;margin-top:6px">Turns off pings.</div>
      <div style="margin-top:10px;display:flex;gap:10px">
        <button class="btn small" id="muteOn">On</button>
        <button class="btn small primary" id="muteOff">Off</button>
      </div>
    </div>
  `);

  setTimeout(()=>{
    document.getElementById("rmOn").onclick = ()=> document.body.classList.add("reduceMotion");
    document.getElementById("rmOff").onclick = ()=> document.body.classList.remove("reduceMotion");

    document.getElementById("curOn").onclick = ()=> enableCursorTrail(true);
    document.getElementById("curOff").onclick = ()=> enableCursorTrail(false);

    document.getElementById("muteOn").onclick = ()=> socket.emit("updateSettings", { muteAll: true });
    document.getElementById("muteOff").onclick = ()=> socket.emit("updateSettings", { muteAll: false });
  }, 0);
};

/* ---------- cursor trail (short + fast) ---------- */
let cursorEnabled = false;
const tA = $("trailA"), tB = $("trailB"), tC = $("trailC");
let mouseX = 0, mouseY = 0;
let aX=0,aY=0,bX=0,bY=0,cX=0,cY=0;
let cursorRAF = null;

function enableCursorTrail(on){
  cursorEnabled = !!on;
  if(cursorEnabled){
    document.body.classList.add("cursorHide");
    tA.style.opacity = "1"; tB.style.opacity = "1"; tC.style.opacity = "1";
    if(!cursorRAF) tickCursor();
  }else{
    document.body.classList.remove("cursorHide");
    tA.style.opacity = "0"; tB.style.opacity = "0"; tC.style.opacity = "0";
    if(cursorRAF){ cancelAnimationFrame(cursorRAF); cursorRAF = null; }
  }
}
window.addEventListener("mousemove", (e)=>{
  mouseX = e.clientX;
  mouseY = e.clientY;
});
function tickCursor(){
  const speed = 0.35; // faster
  aX += (mouseX - aX) * speed;
  aY += (mouseY - aY) * speed;
  bX += (aX - bX) * speed;
  bY += (aY - bY) * speed;
  cX += (bX - cX) * speed;
  cY += (bY - cY) * speed;

  tA.style.transform = `translate(${aX}px,${aY}px) translate(-50%,-50%)`;
  tB.style.transform = `translate(${bX}px,${bY}px) translate(-50%,-50%)`;
  tC.style.transform = `translate(${cX}px,${cY}px) translate(-50%,-50%)`;

  cursorRAF = requestAnimationFrame(tickCursor);
}

/* ---------- sending messages ---------- */
function sendMessage(){
  const text = messageEl.value.trim();
  if(!text) return;

  // enforce cooldown
  if(!canSendNow()){
    warnCooldown();
    return;
  }

  if(activeView === "global"){
    socket.emit("chat", { text });
  }else if(activeView === "dm"){
    socket.emit("sendDM", { to: activeTarget, text });
  }else if(activeView === "group"){
    socket.emit("sendGroup", { groupId: activeTarget, text });
  }

  messageEl.value = "";
  lastSentAt = Date.now();
  startCooldownTicker();
}

sendBtn.onclick = sendMessage;
messageEl.addEventListener("keydown",(e)=>{
  if(e.key === "Enter" && !e.shiftKey){
    e.preventDefault();
    sendMessage();
  }
});

/* ---------- socket events ---------- */
socket.on("loginError", (msg)=>{
  openModal("Login failed", `
    <div style="color:var(--muted);font-size:12px;line-height:1.45">
      ${escapeHTML(msg || "Could not log in.")}
    </div>
  `, [{label:"Close", primary:true, onClick: closeModal}]);
});

socket.on("loginSuccess", (data)=>{
  me = data.user;
  myColor = data.color || "#e8edf3";
  isGuest = /^Guest\d+$/i.test(me);

  // cooldown: 5s guest, 3s normal
  setCooldown(isGuest ? 5 : 3);

  // show/hide account pill
  mePill.style.display = "flex";
  meName.textContent = me;

  // guest: swap logout to login button
  if(isGuest){
    logoutBtn.style.display = "none";
    loginBtn.style.display = "flex";
  }else{
    logoutBtn.style.display = "flex";
    loginBtn.style.display = "none";
  }

  // session persistence (non-guest only)
  if(!isGuest){
    const u = usernameEl.value.trim();
    const p = passwordEl.value;
    if(u && p) saveSession(u, p);
  }

  // beta warning logic:
  // - show big warning only when entering guest OR first time overall
  // - do NOT show it again if user was already warned in guest mode earlier
  if(isGuest && !hasShownGuestWarning()){
    markGuestWarningShown();
    openModal("Important (beta)", `
      <div style="color:var(--muted);font-size:12px;line-height:1.5">
        <b style="color:#e9eff7">This website is still in beta.</b><br>
        If you have issues or suggestions, DM <b style="color:#e9eff7">fishy_x1</b> on Discord.
      </div>
    `, [{label:"Got it", primary:true, onClick: closeModal}]);
  }

  // Transition
  setLoading(true, "loading your session…");
  setTimeout(()=>{
    setLoading(false);
    showApp();
    openGlobal();
    startCooldownTicker();
  }, 420);
});

socket.on("history", (msgs)=>{
  // server global history
  globalCache = Array.isArray(msgs) ? msgs : [];
  // filter invalid timestamps
  globalCache = globalCache.filter(m => !!fmtTime(m?.ts));
  if(activeView === "global") renderMessages(globalCache, "global");
});

socket.on("chat", (msg)=>{
  // new global msg
  if(!msg?.ts || !fmtTime(msg.ts)) return;
  globalCache.push(msg);
  if(globalCache.length > 400) globalCache.shift();

  if(activeView === "global") {
    appendOneMessage(msg);
  } else {
    // if user muted global in settings later, server should handle pings; client can show pings in list (optional)
  }
});

function appendOneMessage(m){
  const time = fmtTime(m.ts);
  if(!time) return;
  const user = m.user || "unknown";
  const color = m.color || "#e8edf3";

  const el = document.createElement("div");
  el.className = "msg";
  el.innerHTML = `
    <div class="avatar"><div style="position:absolute;inset:0;background:${escapeHTML(color)};opacity:.12"></div></div>
    <div class="bubble">
      <div class="meta">
        <div class="u" style="color:${escapeHTML(color)}">${escapeHTML(user)}</div>
        <div class="t">${escapeHTML(time)}</div>
      </div>
      <div class="body">${escapeHTML(m.text || "")}</div>
    </div>
  `;
  chatBox.appendChild(el);
  scrollToBottom();
}

socket.on("onlineUsers", (arr)=>{
  onlineUsers = Array.isArray(arr) ? arr : [];
  if(activeView === "global") renderGlobalSidebar();
});

socket.on("state", (payload)=>{
  // server state for non-guest:
  // expected fields: messagesList, inboxItems, pings, settings, etc.
  if(!payload) return;

  messagesList = Array.isArray(payload.messagesList) ? payload.messagesList : messagesList;
  inboxItems = Array.isArray(payload.inboxItems) ? payload.inboxItems : inboxItems;

  // update pings
  const msgUnread = payload.msgUnreadTotal || 0;
  const inboxUnread = payload.inboxUnreadTotal || 0;

  const mp = $("msgPing");
  const ip = $("inboxPing");

  mp.textContent = String(msgUnread);
  ip.textContent = String(inboxUnread);

  mp.classList.toggle("show", msgUnread > 0);
  ip.classList.toggle("show", inboxUnread > 0);

  // refresh current sidebar if needed
  if(activeView === "dm" || activeView === "group"){
    renderMessagesSidebar();
  }
  if(tabInbox.classList.contains("primary")){
    renderInboxSidebar();
  }
});

socket.on("dmHistory", (data)=>{
  if(!data?.withUser) return;
  const key = `dm:${data.withUser}`;
  const msgs = Array.isArray(data.msgs) ? data.msgs.filter(m=>!!fmtTime(m?.ts)) : [];
  dmCache.set(key, msgs);

  // if currently viewing this DM
  if(activeView === "dm" && activeTarget === data.withUser){
    renderMessages(msgs, "dm");
  }
});

socket.on("dm", (m)=>{
  // new DM message
  if(!m?.ts || !fmtTime(m.ts)) return;
  const other = (m.from === me) ? m.to : m.from;
  const key = `dm:${other}`;
  const list = dmCache.get(key) || [];
  list.push(m);
  if(list.length > 400) list.shift();
  dmCache.set(key, list);

  if(activeView === "dm" && activeTarget === other){
    appendOneMessage({
      user: m.from,
      text: m.text,
      ts: m.ts,
      color: m.colors?.[m.from] || "#e8edf3"
    });
  }
});

socket.on("groupHistory", (data)=>{
  if(!data?.groupId) return;
  const msgs = Array.isArray(data.msgs) ? data.msgs.filter(m=>!!fmtTime(m?.ts)) : [];
  groupCache.set(data.groupId, msgs);
  if(activeView === "group" && activeTarget === data.groupId){
    renderMessages(msgs, "group");
  }
});

socket.on("groupMsg", (m)=>{
  if(!m?.ts || !fmtTime(m.ts)) return;
  const gid = m.groupId;
  const list = groupCache.get(gid) || [];
  list.push(m);
  if(list.length > 500) list.shift();
  groupCache.set(gid, list);

  if(activeView === "group" && activeTarget === gid){
    appendOneMessage({
      user: m.user,
      text: m.text,
      ts: m.ts,
      color: m.color || "#e8edf3"
    });
  }
});

socket.on("actionError", (payload)=>{
  // only for meaningful errors
  const msg = payload?.msg || "Action failed.";
  openModal("Notice", `
    <div style="color:var(--muted);font-size:12px;line-height:1.45">${escapeHTML(msg)}</div>
  `, [{label:"Close", primary:true, onClick: closeModal}]);
});

/* ---------- auto login on refresh (non-guest only) ---------- */
(function boot(){
  showLogin();
  setLoading(false);
  renderGlobalSidebar();

  const sess = loadSession();
  if(sess){
    // silent auto-login
    usernameEl.value = sess.user;
    passwordEl.value = sess.pass;

    setLoading(true, "restoring session…");
    setTimeout(()=>{
      doLogin(sess.user, sess.pass);
    }, 200);
  }
})();
