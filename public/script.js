const socket = io();

const $ = (id) => document.getElementById(id);

// UI refs
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
const backToGlobal = $("backToGlobal");

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

// Emoji
const emojiToggle = $("emojiToggle");
const emojiPicker = $("emojiPicker");
const emojiGrid = $("emojiGrid");
const emojiSearch = $("emojiSearch");

// Cursor trail
const trailA = $("trailA");
const trailB = $("trailB");
const trailC = $("trailC");

// State
let me = null;
let isGuest = false;
let token = localStorage.getItem("tonkotsu_token") || null;

let view = { type: "none", id: null }; // global | dm | group
let unread = { global: 0, dm: {}, group: {} };
let settings = null;

let globalCache = []; // keeps global messages so clicking global doesn't clear
let dmCache = new Map(); // key user -> msgs
let groupCache = new Map(); // gid -> msgs

let cooldownUntil = 0;

// Sounds (simple & subtle)
const audioPing = new Audio();
audioPing.src =
  "data:audio/wav;base64,UklGRoQAAABXQVZFZm10IBAAAAABAAEAgLsAAAB3AQACABAAZGF0YVgAAACAgICAgICAgICAf39/f39/f4CAgICAgICAgICAf39/f39/f4CAgICAgICAgICAf39/f39/f4CAgICAgICAgICAf39/f39/f4CAgICAgICAgICA=";

// ---------- basic helpers ----------
function now() { return Date.now(); }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function toast(title, msg) {
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
  setTimeout(() => { d.style.opacity = "0"; d.style.transform = "translateY(10px)"; }, 2800);
  setTimeout(() => d.remove(), 3300);
}

function escapeHtml(s){
  return String(s || "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function showLoading(text="syncing…"){
  $("loaderSub").textContent = text;
  loading.classList.add("show");
}
function hideLoading(){
  loading.classList.remove("show");
}

function openModal(title, html) {
  modalTitle.textContent = title;
  modalBody.innerHTML = html;
  modalBack.classList.add("show");
}
function closeModal() {
  modalBack.classList.remove("show");
}
modalClose.addEventListener("click", closeModal);
modalBack.addEventListener("click", (e) => { if (e.target === modalBack) closeModal(); });

// ---------- eye button ----------
togglePass.addEventListener("click", () => {
  const isPw = passwordEl.type === "password";
  passwordEl.type = isPw ? "text" : "password";
  togglePass.textContent = isPw ? "🙈" : "👁";
});

// ---------- emoji picker ----------
const EMOJIS = "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 🤪 😜 😝 😛 🫠 🤭 🤗 🤔 🫡 😶‍🌫️ 😶 😐 😑 😬 🙄 😴 🤤 😪 😮‍💨 😵‍💫 😵 🤯 😲 😳 🥵 🥶 😱 😨 😰 😥 😓 🤥 😡 😠 🤬 😤 😭 😢 🥲 😔 😞 😟 😕 🙁 ☹️ 😮 😯 😶‍🌫️ 😦 😧 😩 😫 😖 😣 😿 😾 💀 ☠️ 👻 👽 🤖 🎃 ❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 💯 ✨ ⭐️ 🌙 🔥 👍 👎 👊 ✊ 🤝 🙌 👏 🙏 🤌 🤏 👀 🧠 💡 🎉 🎶 🔔 ✅ ❌ ⚠️".split(" ");

function renderEmojis(filter="") {
  emojiGrid.innerHTML = "";
  const f = filter.trim();
  const list = f ? EMOJIS.filter(e => e.includes(f)) : EMOJIS;

  list.slice(0, 240).forEach(e => {
    const b = document.createElement("button");
    b.className = "emojiBtn";
    b.textContent = e;
    b.onclick = () => {
      messageEl.value += e;
      messageEl.focus();
      emojiPicker.classList.remove("show");
    };
    emojiGrid.appendChild(b);
  });
}
renderEmojis();

emojiToggle.addEventListener("click", (e) => {
  e.stopPropagation();
  emojiPicker.classList.toggle("show");
  emojiSearch.value = "";
  renderEmojis("");
  emojiSearch.focus();
});
emojiSearch.addEventListener("input", () => renderEmojis(emojiSearch.value));
document.addEventListener("click", (e) => {
  if (!emojiPicker.contains(e.target) && e.target !== emojiToggle) emojiPicker.classList.remove("show");
});

// ---------- custom cursor ----------
let cursorEnabled = false;
let trail = [
  { el: trailA, x: 0, y: 0 },
  { el: trailB, x: 0, y: 0 },
  { el: trailC, x: 0, y: 0 }
];
let mouseX = 0, mouseY = 0;

function setCursor(enabled){
  cursorEnabled = !!enabled;
  document.body.classList.toggle("cursorHide", cursorEnabled);
  for (const t of trail) t.el.style.opacity = cursorEnabled ? "1" : "0";
}

document.addEventListener("mousemove", (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;
});

function tickTrail(){
  if (cursorEnabled) {
    // faster + shorter trail
    trail[0].x += (mouseX - trail[0].x) * 0.60;
    trail[0].y += (mouseY - trail[0].y) * 0.60;

    trail[1].x += (trail[0].x - trail[1].x) * 0.55;
    trail[1].y += (trail[0].y - trail[1].y) * 0.55;

    trail[2].x += (trail[1].x - trail[2].x) * 0.50;
    trail[2].y += (trail[1].y - trail[2].y) * 0.50;

    trail.forEach((t, i) => {
      t.el.style.left = t.x + "px";
      t.el.style.top = t.y + "px";
      t.el.style.transform = "translate(-50%,-50%) scale(" + (1 - i*0.12) + ")";
    });
  }
  requestAnimationFrame(tickTrail);
}
tickTrail();

// ---------- reduce motion ----------
function setReduceMotion(on){
  document.body.classList.toggle("reduceMotion", !!on);
}

// ---------- cooldown ----------
function cooldownSeconds(){
  return isGuest ? 5 : 3;
}
function canSend(){
  return now() >= cooldownUntil;
}
function startCooldown(){
  const secs = cooldownSeconds();
  cooldownUntil = now() + secs * 1000;
  cooldownRow.style.display = "flex";
  updateCooldown();
}
function updateCooldown(){
  const msLeft = cooldownUntil - now();
  const total = cooldownSeconds() * 1000;
  const p = clamp(1 - msLeft / total, 0, 1);
  cdFill.style.width = (p * 100) + "%";

  if (msLeft <= 0) {
    cooldownRow.style.display = "none";
    cooldownRow.classList.remove("warn");
    return;
  }
  cooldownText.textContent = (msLeft / 1000).toFixed(1) + "s";
  requestAnimationFrame(updateCooldown);
}
function cooldownWarn(){
  cooldownRow.style.display = "flex";
  cooldownRow.classList.add("warn");
  cooldownRow.classList.add("shake");
  setTimeout(() => cooldownRow.classList.remove("shake"), 380);
  setTimeout(() => cooldownRow.classList.remove("warn"), 900);
}

// ---------- view switching ----------
function setView(type, id=null){
  view = { type, id };
  socket.emit("view:set", view);

  // UI labels
  if (type === "global") {
    chatTitle.textContent = "Global chat";
    chatHint.textContent = "shared with everyone online";
    backToGlobal.style.display = "none";
  } else if (type === "dm") {
    chatTitle.textContent = `DM — ${id}`;
    chatHint.textContent = "private messages";
    backToGlobal.style.display = "inline-flex";
  } else if (type === "group") {
    chatTitle.textContent = `Group — ${id}`;
    chatHint.textContent = "group chat";
    backToGlobal.style.display = "inline-flex";
  }
}

backToGlobal.addEventListener("click", () => {
  openGlobal(true);
});

// ---------- message rendering ----------
function fmtTime(ts){
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return null;
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function addMessageToUI({ user, text, ts }, { scope="global", from=null } = {}) {
  // skip bad timestamp messages (you asked)
  const t = fmtTime(ts);
  if (!t) return;

  const row = document.createElement("div");
  row.className = "msg";
  const who = scope === "dm" ? from : user;

  row.innerHTML = `
    <div class="bubble">
      <div class="meta">
        <div class="u">${escapeHtml(who || "—")}${(who === me ? " (You)" : "")}</div>
        <div class="t">${t}</div>
      </div>
      <div class="body">${escapeHtml(text)}</div>
    </div>
  `;
  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function clearChat(){
  chatBox.innerHTML = "";
}

// ---------- sidebars ----------
let onlineUsers = []; // [{user}]
function renderSidebarGlobal(){
  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:900;font-size:12px;color:#dbe6f1">Online</div>
      <div style="font-size:11px;color:var(--muted)">${onlineUsers.length}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${onlineUsers.map(u => `
        <div class="row" data-user="${escapeHtml(u.user)}">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(u.user)}${u.user===me ? " (You)" : ""}</div>
              <div class="rowSub">online</div>
            </div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderSidebarMessages(){
  // DMs + groups list (compact)
  const dmKeys = Object.keys(unread.dm || {});
  const grpKeys = Object.keys(unread.group || {});

  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:900;font-size:12px;color:#dbe6f1">Messages</div>
      <button class="btn small" id="createGroupBtn">Create group</button>
    </div>

    <div style="font-size:11px;color:var(--muted);margin-top:-2px">
      DMs and groups you’ve opened will appear here.
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px" id="msgList"></div>
  `;

  const list = $("msgList");

  // DMs (from unread.dm keys + any cached DMs)
  const dmUsers = new Set([...dmKeys, ...Array.from(dmCache.keys())]);
  for (const u of Array.from(dmUsers).sort()) {
    if (!u) continue;
    const count = unread.dm?.[u] || 0;
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.dm = u;
    row.innerHTML = `
      <div class="rowLeft">
        <div class="statusDot ${onlineUsers.some(x=>x.user===u) ? "on" : ""}"></div>
        <div class="nameCol">
          <div class="rowName">${escapeHtml(u)}</div>
          <div class="rowSub">dm</div>
        </div>
      </div>
      <div class="rowRight">
        <span class="ping ${count>0 ? "show" : ""}">${count}</span>
      </div>
    `;
    list.appendChild(row);
  }

  // Groups (from unread.group + cache)
  const groups = new Set([...grpKeys, ...Array.from(groupCache.keys())]);
  for (const gid of Array.from(groups).sort()) {
    const count = unread.group?.[gid] || 0;
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.group = gid;
    row.innerHTML = `
      <div class="rowLeft">
        <div class="statusDot on"></div>
        <div class="nameCol">
          <div class="rowName">${escapeHtml(gid)}</div>
          <div class="rowSub">group</div>
        </div>
      </div>
      <div class="rowRight">
        <span class="ping ${count>0 ? "show" : ""}">${count}</span>
      </div>
    `;
    list.appendChild(row);
  }

  // Create group popup (NO alerts)
  $("createGroupBtn").onclick = () => {
    if (isGuest) {
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
    setTimeout(() => $("gcName")?.focus(), 50);
    $("gcCreate").onclick = () => {
      const name = $("gcName").value.trim();
      if (!name) return;
      closeModal();
      socket.emit("group:create", { name });
      toast("Group", "Creating group…");
    };
  };

  // Click handlers
  list.querySelectorAll("[data-dm]").forEach(el => {
    el.addEventListener("click", () => openDM(el.dataset.dm));
  });
  list.querySelectorAll("[data-group]").forEach(el => {
    el.addEventListener("click", () => openGroup(el.dataset.group));
  });
}

function renderSidebarInbox(){
  // Minimal inbox stub (you can expand later)
  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:900;font-size:12px;color:#dbe6f1">Inbox</div>
      <div style="font-size:11px;color:var(--muted)">requests + updates</div>
    </div>
    <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px;line-height:1.45">
      Inbox is ready for friend/group requests later.
      <br><br>
      For now: pings are handled in the Messages tab.
    </div>
  `;
}

// ---------- open global/dm/group ----------
function openGlobal(force=false){
  setView("global");
  tabGlobal.classList.add("primary");
  tabMessages.classList.remove("primary");
  tabInbox.classList.remove("primary");

  // IMPORTANT: don't clear unless force is true AND we will re-render cached
  if (force) {
    clearChat();
    globalCache.forEach(m => addMessageToUI({ user: m.user, text: m.text, ts: m.ts }));
  }

  // ask server for global history (keeps accurate)
  socket.emit("requestGlobalHistory");
  renderSidebarGlobal();
}

function openDM(user){
  if (isGuest) {
    toast("Guests", "Guests can’t DM. Log in to use DMs.");
    return;
  }
  setView("dm", user);

  tabGlobal.classList.remove("primary");
  tabMessages.classList.add("primary");
  tabInbox.classList.remove("primary");

  clearChat();
  socket.emit("dm:history", { withUser: user });
  renderSidebarMessages();
}

function openGroup(groupId){
  if (isGuest) return;
  setView("group", groupId);

  tabGlobal.classList.remove("primary");
  tabMessages.classList.add("primary");
  tabInbox.classList.remove("primary");

  clearChat();
  socket.emit("group:history", { groupId });
  renderSidebarMessages();
}

// ---------- settings ----------
function renderSettings(){
  const s = settings || {
    muteAll:false, muteGlobal:true, muteDM:false, muteGroups:false,
    sound:true, volume:0.2, reduceMotion:false, customCursor:false, dmCensor:false
  };

  openModal("Settings", `
    <div class="toggleRow">
      <div class="toggleLeft">
        <div class="toggleName">Sound</div>
        <div class="toggleDesc">Message pings & small UI sounds.</div>
      </div>
      <div class="switch ${s.sound ? "on":""}" data-k="sound"></div>
    </div>

    <div class="toggleRow">
      <div class="toggleLeft">
        <div class="toggleName">Mute all notifications</div>
        <div class="toggleDesc">Stops pings & counts.</div>
      </div>
      <div class="switch ${s.muteAll ? "on":""}" data-k="muteAll"></div>
    </div>

    <div class="toggleRow">
      <div class="toggleLeft">
        <div class="toggleName">Global pings</div>
        <div class="toggleDesc">Default off (recommended).</div>
      </div>
      <div class="switch ${!s.muteGlobal ? "on":""}" data-k="globalOn"></div>
    </div>

    <div class="toggleRow">
      <div class="toggleLeft">
        <div class="toggleName">DM pings</div>
        <div class="toggleDesc">Enable/disable unread pings for DMs.</div>
      </div>
      <div class="switch ${!s.muteDM ? "on":""}" data-k="dmOn"></div>
    </div>

    <div class="toggleRow">
      <div class="toggleLeft">
        <div class="toggleName">Group pings</div>
        <div class="toggleDesc">Enable/disable unread pings for groups.</div>
      </div>
      <div class="switch ${!s.muteGroups ? "on":""}" data-k="groupsOn"></div>
    </div>

    <div class="toggleRow">
      <div class="toggleLeft">
        <div class="toggleName">Reduce motion</div>
        <div class="toggleDesc">Less animation for performance.</div>
      </div>
      <div class="switch ${s.reduceMotion ? "on":""}" data-k="reduceMotion"></div>
    </div>

    <div class="toggleRow">
      <div class="toggleLeft">
        <div class="toggleName">Custom cursor</div>
        <div class="toggleDesc">Hidden cursor + quick trail.</div>
      </div>
      <div class="switch ${s.customCursor ? "on":""}" data-k="customCursor"></div>
    </div>

    <div class="toggleRow">
      <div class="toggleLeft">
        <div class="toggleName">DM censor (optional)</div>
        <div class="toggleDesc">Hide harsh words in DMs (less strict).</div>
      </div>
      <div class="switch ${s.dmCensor ? "on":""}" data-k="dmCensor"></div>
    </div>

    <div style="display:flex;gap:10px;align-items:center;padding:10px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
      <div style="font-weight:800;font-size:12px">Volume</div>
      <input id="vol" type="range" min="0" max="1" step="0.01" value="${Number(s.volume ?? 0.2)}" style="width:100%">
    </div>

    <div style="display:flex;gap:10px">
      <button class="btn primary" id="saveSettings">Save</button>
      <button class="btn" id="closeSettings">Close</button>
    </div>
  `);

  modalBody.querySelectorAll(".switch").forEach(sw => {
    sw.addEventListener("click", () => sw.classList.toggle("on"));
  });

  $("closeSettings").onclick = closeModal;
  $("saveSettings").onclick = () => {
    const get = (k) => modalBody.querySelector(`.switch[data-k="${k}"]`)?.classList.contains("on");

    // note: "globalOn" means NOT muted
    const next = {
      sound: get("sound"),
      muteAll: get("muteAll"),
      muteGlobal: !get("globalOn"),
      muteDM: !get("dmOn"),
      muteGroups: !get("groupsOn"),
      reduceMotion: get("reduceMotion"),
      customCursor: get("customCursor"),
      dmCensor: get("dmCensor"),
      volume: parseFloat($("vol").value || "0.2"),
    };

    settings = next;
    applyLocalSettings();
    socket.emit("settings:update", next);
    toast("Settings", "Saved.");
    closeModal();
  };
}

function applyLocalSettings(){
  const s = settings || {};
  setReduceMotion(!!s.reduceMotion);
  setCursor(!!s.customCursor);
  audioPing.volume = clamp(Number(s.volume ?? 0.2), 0, 1);
}

// ---------- auth buttons ----------
settingsBtn.addEventListener("click", () => {
  if (isGuest) {
    // guests see limited settings only
    openModal("Settings (Guest)", `
      <div style="font-size:12px;color:var(--muted);line-height:1.45">
        Guest mode is limited. Log in to save settings and use DMs/groups.
      </div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn primary" id="guestClose">Close</button>
      </div>
    `);
    $("guestClose").onclick = closeModal;
    return;
  }
  renderSettings();
});

logoutBtn.addEventListener("click", () => {
  // transition out
  showLoading("logging out…");
  setTimeout(() => {
    localStorage.removeItem("tonkotsu_token");
    location.reload();
  }, 650);
});

loginBtn.addEventListener("click", () => {
  // guest -> login
  loginOverlay.classList.remove("hidden");
});

// ---------- join buttons ----------
function shakeLogin(){
  const card = document.querySelector(".loginCard");
  card.classList.add("shake");
  setTimeout(() => card.classList.remove("shake"), 380);
}

joinBtn.addEventListener("click", () => {
  const u = usernameEl.value.trim();
  const p = passwordEl.value;

  // YOU asked: join does nothing if missing creds
  if (!u || !p) {
    shakeLogin();
    return;
  }

  showLoading("logging in…");
  socket.emit("login", { username: u, password: p, guest: false });
});

guestBtn.addEventListener("click", () => {
  showLoading("joining as guest…");
  socket.emit("login", { guest: true });
});

// enter key submit on login
passwordEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBtn.click();
});

// ---------- sending ----------
sendBtn.addEventListener("click", sendCurrent);
messageEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCurrent();
  }
});

function sendCurrent(){
  if (!me) return;

  if (!canSend()) {
    cooldownWarn();
    return;
  }

  const text = messageEl.value.trim();
  if (!text) return;

  startCooldown();
  messageEl.value = "";

  if (view.type === "global") {
    socket.emit("sendGlobal", { text, ts: now() });
  } else if (view.type === "dm") {
    socket.emit("dm:send", { to: view.id, text });
  } else if (view.type === "group") {
    socket.emit("group:send", { groupId: view.id, text });
  }
}

// ---------- tabs ----------
tabGlobal.addEventListener("click", () => {
  tabGlobal.classList.add("primary");
  tabMessages.classList.remove("primary");
  tabInbox.classList.remove("primary");
  openGlobal(true);
});

tabMessages.addEventListener("click", () => {
  tabGlobal.classList.remove("primary");
  tabMessages.classList.add("primary");
  tabInbox.classList.remove("primary");
  renderSidebarMessages();
  // stay on current view; don't clear chat
});

tabInbox.addEventListener("click", () => {
  tabGlobal.classList.remove("primary");
  tabMessages.classList.remove("primary");
  tabInbox.classList.add("primary");
  renderSidebarInbox();
});

// ---------- socket events ----------
socket.on("loginSuccess", (data) => {
  hideLoading();

  me = data.username;
  isGuest = !!data.guest;

  // store token only if not guest
  if (!isGuest && data.token) {
    localStorage.setItem("tonkotsu_token", data.token);
    token = data.token;
  }

  settings = data.settings || settings;
  unread = data.unread || unread;

  applyLocalSettings();

  // show app
  loginOverlay.classList.add("hidden");
  app.classList.add("ready");

  mePill.style.display = "flex";
  meName.textContent = me;

  // guest mode UI limits
  if (isGuest) {
    // no logout; show login instead
    logoutBtn.style.display = "none";
    settingsBtn.style.display = "none";
    loginBtn.style.display = "inline-flex";

    const warned = localStorage.getItem("tonkotsu_beta_warned");
    if (!warned) {
      toast("Beta", "Guest mode is limited. If you find issues, DM fishy_x1 on Discord.");
      localStorage.setItem("tonkotsu_beta_warned", "1");
    }
  } else {
    logoutBtn.style.display = "inline-flex";
    settingsBtn.style.display = "inline-flex";
    loginBtn.style.display = "none";
  }

  // start in global
  tabGlobal.classList.add("primary");
  openGlobal(true);

  // request groups list for messages tab caching
  if (!isGuest) socket.emit("groups:list");

  toast("Logged in", isGuest ? "Joined as Guest" : `Welcome back, ${me}`);
});

socket.on("resumeFail", () => {
  // token invalid; show login
  localStorage.removeItem("tonkotsu_token");
  token = null;
});

socket.on("loginError", (msg) => {
  hideLoading();
  shakeLogin();
  // no spammy toasts, but this is important
  toast("Login", msg || "Login failed");
});

socket.on("onlineUsers", (list) => {
  onlineUsers = Array.isArray(list) ? list : [];
  // if we're on global or empty, re-render
  if (tabGlobal.classList.contains("primary")) renderSidebarGlobal();
});

socket.on("history", (msgs) => {
  // update cache
  globalCache = (Array.isArray(msgs) ? msgs : [])
    .filter(m => Number.isFinite(new Date(m.ts).getTime())); // remove inaccurate timestamp msgs

  // if we are viewing global, render from cache
  if (view.type === "global") {
    clearChat();
    globalCache.forEach(m => addMessageToUI({ user: m.user, text: m.text, ts: m.ts }));
  }
});

socket.on("globalMessage", (m) => {
  if (!m || !Number.isFinite(new Date(m.ts).getTime())) return;
  globalCache.push(m);

  if (view.type === "global") {
    addMessageToUI({ user: m.user, text: m.text, ts: m.ts });
  }
});

socket.on("sendError", (e) => {
  // only show important toasts
  const reason = e?.reason || "Blocked.";
  toast("Message blocked", reason);
});

socket.on("dm:history", ({ withUser, msgs }) => {
  dmCache.set(withUser, msgs || []);
  if (view.type === "dm" && view.id === withUser) {
    clearChat();
    (msgs || []).forEach(m => addMessageToUI({ user: m.from, text: m.text, ts: m.ts }, { scope:"dm", from: m.from }));
  }
});

socket.on("dm:message", (m) => {
  if (!m) return;
  const other = (m.from === me) ? m.to : m.from;
  const key = other;

  if (!dmCache.has(key)) dmCache.set(key, []);
  dmCache.get(key).push(m);

  if (view.type === "dm" && view.id === other) {
    addMessageToUI({ user: m.from, text: m.text, ts: m.ts }, { scope:"dm", from: m.from });
  }
});

socket.on("groups:list", (list) => {
  // cache groups list by id (empty messages until opened)
  (list || []).forEach(g => {
    if (!groupCache.has(g.id)) groupCache.set(g.id, []);
  });
  if (tabMessages.classList.contains("primary")) renderSidebarMessages();
});

socket.on("group:created", (g) => {
  if (!g) return;
  groupCache.set(g.id, g.messages || []);
  toast("Group", `Created “${g.name}”`);
  if (tabMessages.classList.contains("primary")) renderSidebarMessages();
});

socket.on("group:history", ({ groupId, msgs, meta }) => {
  groupCache.set(groupId, msgs || []);
  if (view.type === "group" && view.id === groupId) {
    clearChat();
    (msgs || []).forEach(m => addMessageToUI({ user: m.user, text: m.text, ts: m.ts }));
    if (meta?.name) chatTitle.textContent = `Group — ${meta.name}`;
  }
});

socket.on("group:message", ({ groupId, msg }) => {
  if (!groupCache.has(groupId)) groupCache.set(groupId, []);
  groupCache.get(groupId).push(msg);

  if (view.type === "group" && view.id === groupId) {
    addMessageToUI({ user: msg.user, text: msg.text, ts: msg.ts });
  }
});

socket.on("group:meta", ({ groupId, name, owner }) => {
  // owner changes apply instantly (server already updates)
  if (view.type === "group" && view.id === groupId && name) {
    chatTitle.textContent = `Group — ${name}`;
  }
});

socket.on("unread", (u) => {
  unread = u || unread;
  updatePings();
  // refresh messages tab if open
  if (tabMessages.classList.contains("primary")) renderSidebarMessages();
});

socket.on("settings", (s) => {
  settings = s;
  applyLocalSettings();
});

// ---------- ping UI ----------
function updatePings(){
  // Messages ping = sum of dm + group
  const dmSum = Object.values(unread.dm || {}).reduce((a,b)=>a+(b||0),0);
  const gSum = Object.values(unread.group || {}).reduce((a,b)=>a+(b||0),0);
  const total = dmSum + gSum;

  if (total > 0) {
    msgPing.textContent = String(total);
    msgPing.classList.add("show");
  } else {
    msgPing.classList.remove("show");
  }

  // Inbox ping not used heavily here
  inboxPing.classList.remove("show");

  // play sound if enabled and not muted
  const s = settings || {};
  if (s.sound && !(s.muteAll) && total > 0) {
    try { audioPing.currentTime = 0; audioPing.play().catch(()=>{}); } catch {}
  }
}

// ---------- auto-login / resume ----------
window.addEventListener("load", () => {
  $("year").textContent = new Date().getFullYear();

  app.classList.add("ready"); // smooth entrance for layout

  // try resume
  if (token) {
    showLoading("reconnecting…");
    socket.emit("resume", { token });
    // if resume fails, server emits resumeFail and overlay remains
    setTimeout(() => hideLoading(), 1100);
  }
});
