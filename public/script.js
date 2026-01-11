/* global io */
const socket = io();

// ---- DOM ----
const yearEl = document.getElementById("year");
yearEl.textContent = String(new Date().getFullYear());

const loginCard = document.getElementById("loginCard");
const chatCard = document.getElementById("chatCard");
const loginHint = document.getElementById("loginHint");

const usernameEl = document.getElementById("username");
const passwordEl = document.getElementById("password");
const loginBtn = document.getElementById("loginBtn");
const guestBtn = document.getElementById("guestBtn");
const togglePw = document.getElementById("togglePw");

const tabGlobal = document.getElementById("tabGlobal");
const tabDMs = document.getElementById("tabDMs");
const tabGroups = document.getElementById("tabGroups");
const dmPill = document.getElementById("dmPill");
const gcPill = document.getElementById("gcPill");

const onlineList = document.getElementById("onlineList");
const messagesEl = document.getElementById("messages");
const messageInput = document.getElementById("messageInput");
const sendBtn = document.getElementById("sendBtn");

const chatTitle = document.getElementById("chatTitle");
const chatSubtitle = document.getElementById("chatSubtitle");

const inboxBtn = document.getElementById("inboxBtn");
const inboxBadge = document.getElementById("inboxBadge");
const settingsBtn = document.getElementById("settingsBtn");
const mePill = document.getElementById("mePill");
const meName = document.getElementById("meName");
const meLevel = document.getElementById("meLevel");

const overlay = document.getElementById("overlay");
const settingsModal = document.getElementById("settingsModal");
const closeSettings = document.getElementById("closeSettings");
const inboxModal = document.getElementById("inboxModal");
const closeInbox = document.getElementById("closeInbox");

const themeSelect = document.getElementById("themeSelect");
const densityRange = document.getElementById("density");
const sidebarRange = document.getElementById("sidebar");
const customCursorToggle = document.getElementById("customCursor");
const pingSoundToggle = document.getElementById("pingSound");
const pingVolumeRange = document.getElementById("pingVolume");

const xpWrap = document.getElementById("xpWrap");
const xpLabel = document.getElementById("xpLabel");
const xpNums = document.getElementById("xpNums");
const xpFill = document.getElementById("xpFill");

const friendRequestsEl = document.getElementById("friendRequests");
const groupInvitesEl = document.getElementById("groupInvites");

const toastHost = document.getElementById("toastHost");

// ---- State ----
let me = { username: null, guest: true, token: null };
let view = { type: "global", withUser: null, groupId: null };
let settings = {
  theme: "dark",
  density: 0.15,
  sidebar: 0.22,
  hideMildProfanity: false,
  customCursor: true,
  pingSound: true,
  pingVolume: 0.45
};
let lastXP = null;

// Minimal ping
let audioCtx = null;
function ping() {
  if (!settings.pingSound) return;
  const vol = Math.max(0, Math.min(1, settings.pingVolume ?? 0.45));

  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();

    // "good ping": short, clean, slightly musical
    o.type = "sine";
    o.frequency.setValueAtTime(880, t);
    o.frequency.exponentialRampToValueAtTime(660, t + 0.06);

    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.15 * vol + 0.0001, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);

    o.connect(g);
    g.connect(audioCtx.destination);

    o.start(t);
    o.stop(t + 0.12);
  } catch {}
}

// ---- Cursor + Trail (dynamic) ----
const trailHost = document.getElementById("cursorTrail");
let trailEnabled = true;
let trailNodes = [];
let mouse = { x: 0, y: 0 };
let lastMove = 0;

function setTrailEnabled(on) {
  trailEnabled = !!on;
  trailHost.style.display = on ? "block" : "none";
  document.body.style.cursor = on ? "none" : "default";
}

function spawnDot(x, y) {
  const dot = document.createElement("div");
  dot.className = "cursorDot";
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;
  dot.style.opacity = "1";
  trailHost.appendChild(dot);
  trailNodes.push({ el: dot, born: performance.now() });
  if (trailNodes.length > 18) {
    const old = trailNodes.shift();
    old.el.remove();
  }
}
window.addEventListener("mousemove", (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  if (!trailEnabled) return;

  const now = performance.now();
  // short + fast trail: throttle a bit
  if (now - lastMove > 12) {
    lastMove = now;
    spawnDot(mouse.x, mouse.y);
  }
});

function animateTrail() {
  const t = performance.now();
  for (const node of trailNodes) {
    const age = t - node.born;
    const life = 180; // short
    const p = Math.min(1, age / life);
    node.el.style.opacity = String(1 - p);
    node.el.style.transform = `translate(-50%,-50%) scale(${1 - p * 0.35})`;
    if (p >= 1) {
      node.el.remove();
    }
  }
  trailNodes = trailNodes.filter(n => n.el.isConnected);
  requestAnimationFrame(animateTrail);
}
requestAnimationFrame(animateTrail);

// ---- UI helpers ----
function showToast(title, sub) {
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `<div class="toastTitle">${escapeHTML(title)}</div><div class="toastSub">${escapeHTML(sub)}</div>`;
  toastHost.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transform = "translateY(8px)";
    t.style.transition = "opacity .2s ease, transform .2s ease";
    setTimeout(() => t.remove(), 220);
  }, 1800);
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

function setActiveTab(type) {
  for (const btn of [tabGlobal, tabDMs, tabGroups]) btn.classList.remove("active");
  if (type === "global") tabGlobal.classList.add("active");
  if (type === "dms") tabDMs.classList.add("active");
  if (type === "groups") tabGroups.classList.add("active");
}

function openModal(which) {
  overlay.hidden = false;
  which.hidden = false;
}
function closeModals() {
  overlay.hidden = true;
  settingsModal.hidden = true;
  inboxModal.hidden = true;
}

// ---- Settings apply (prevents overlap issues by only adjusting CSS vars) ----
function applySettingsToUI() {
  // density controls compactness (font/spacing) via a scale
  const scale = 1 - (settings.density * 0.12); // subtle
  document.documentElement.style.setProperty("--appW", `${Math.round(1080 * (1 - settings.density * 0.10))}px`);
  document.body.style.fontSize = `${Math.round(14 * scale)}px`;

  // Sidebar width controls grid column
  const sidebarPx = Math.round(240 + (settings.sidebar - 0.16) * 600);
  document.querySelector(".layout").style.gridTemplateColumns = `${sidebarPx}px 1fr`;

  setTrailEnabled(settings.customCursor !== false);
}

// ---- Login persistence ----
const LS_TOKEN = "tonkotsu_token";
const LS_USER = "tonkotsu_user";
function saveSession(token, username) {
  if (!token) return;
  localStorage.setItem(LS_TOKEN, token);
  localStorage.setItem(LS_USER, username || "");
}
function clearSession() {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USER);
}
function tryResume() {
  const token = localStorage.getItem(LS_TOKEN);
  if (token) socket.emit("resume", { token });
}
tryResume();

// ---- Login UI ----
togglePw.addEventListener("click", () => {
  passwordEl.type = passwordEl.type === "password" ? "text" : "password";
});

loginBtn.addEventListener("click", () => {
  const u = usernameEl.value.trim();
  const p = passwordEl.value;
  socket.emit("login", { username: u, password: p, guest: false });
});

guestBtn.addEventListener("click", () => {
  socket.emit("login", { guest: true });
});

// ---- Tabs behavior ----
tabGlobal.addEventListener("click", () => {
  view = { type: "global", withUser: null, groupId: null };
  setActiveTab("global");
  setChatHeader("Global", "Public chat");
  clearMessages();
  socket.emit("requestGlobalHistory");
});
tabDMs.addEventListener("click", () => {
  view = { type: "dms", withUser: null, groupId: null };
  setActiveTab("dms");
  setChatHeader("DMs", "Pick someone from Online to DM");
  clearMessages();
});
tabGroups.addEventListener("click", () => {
  view = { type: "groups", withUser: null, groupId: null };
  setActiveTab("groups");
  setChatHeader("Group Chats", "Create/Join via inbox invites");
  clearMessages();
  socket.emit("groups:list");
});

// ---- Chat ----
function setChatHeader(title, sub) {
  chatTitle.textContent = title;
  chatSubtitle.textContent = sub;
}

function clearMessages() {
  messagesEl.innerHTML = "";
}

function addMessage({ user, text, ts }) {
  const wrap = document.createElement("div");
  wrap.className = "msg";
  const time = new Date(ts || Date.now());
  wrap.innerHTML = `
    <div class="msgTop">
      <div class="msgUser">${escapeHTML(user || "??")}</div>
      <div class="msgTime">${time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
    </div>
    <div class="msgText">${escapeHTML(text || "")}</div>
  `;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

sendBtn.addEventListener("click", sendCurrent);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendCurrent();
});

function sendCurrent() {
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.value = "";

  if (view.type === "global") {
    socket.emit("sendGlobal", { text, ts: Date.now() });
    return;
  }
  if (view.type === "dms" && view.withUser) {
    socket.emit("dm:send", { to: view.withUser, text });
    return;
  }
  if (view.type === "groups" && view.groupId) {
    socket.emit("group:send", { groupId: view.groupId, text });
    return;
  }

  showToast("Not ready", "Select a DM or Group first.");
}

// ---- Inbox + settings buttons ----
overlay.addEventListener("click", closeModals);
settingsBtn.addEventListener("click", () => openModal(settingsModal));
closeSettings.addEventListener("click", closeModals);

inboxBtn.addEventListener("click", () => {
  openModal(inboxModal);
  socket.emit("social:sync");
});
closeInbox.addEventListener("click", closeModals);

// ---- Profile (click username pill) ----
mePill.addEventListener("click", () => {
  if (!me.username) return;
  socket.emit("profile:get", { user: me.username });
});

// ---- Settings controls (smooth, no overlap) ----
function bindSettingsUI() {
  themeSelect.value = settings.theme || "dark";
  densityRange.value = String(settings.density ?? 0.15);
  sidebarRange.value = String(settings.sidebar ?? 0.22);
  customCursorToggle.checked = settings.customCursor !== false;
  pingSoundToggle.checked = settings.pingSound !== false;
  pingVolumeRange.value = String(settings.pingVolume ?? 0.45);

  applySettingsToUI();
}

let settingsDebounce = null;
function pushSettings() {
  clearTimeout(settingsDebounce);
  settingsDebounce = setTimeout(() => {
    socket.emit("settings:update", settings);
  }, 120);
}

themeSelect.addEventListener("change", () => {
  settings.theme = themeSelect.value;
  pushSettings();
});
densityRange.addEventListener("input", () => {
  settings.density = Number(densityRange.value);
  applySettingsToUI();
  pushSettings();
});
sidebarRange.addEventListener("input", () => {
  settings.sidebar = Number(sidebarRange.value);
  applySettingsToUI();
  pushSettings();
});
customCursorToggle.addEventListener("change", () => {
  settings.customCursor = customCursorToggle.checked;
  applySettingsToUI();
  pushSettings();
});
pingSoundToggle.addEventListener("change", () => {
  settings.pingSound = pingSoundToggle.checked;
  pushSettings();
});
pingVolumeRange.addEventListener("input", () => {
  settings.pingVolume = Number(pingVolumeRange.value);
  pushSettings();
});

// ---- Socket events ----
socket.on("loginError", (msg) => {
  loginHint.textContent = msg || "Login failed.";
});
socket.on("resumeFail", () => {
  clearSession();
});

socket.on("loginSuccess", (payload) => {
  me = {
    username: payload.username,
    guest: !!payload.guest,
    token: payload.token || null
  };

  meName.textContent = payload.username;

  settings = { ...settings, ...(payload.settings || {}) };
  bindSettingsUI();

  // show chat
  loginCard.hidden = true;
  chatCard.hidden = false;

  // save session only if logged in (not guest)
  if (!me.guest && me.token) saveSession(me.token, me.username);

  // xp
  if (!me.guest && payload.xp) {
    xpWrap.hidden = false;
    updateXP(payload.xp);
  } else {
    xpWrap.hidden = true;
  }

  // default view global
  setActiveTab("global");
  setChatHeader("Global", "Public chat");
  clearMessages();
  socket.emit("requestGlobalHistory");
});

socket.on("settings", (srv) => {
  if (!srv) return;
  settings = { ...settings, ...srv };
  bindSettingsUI();
});

socket.on("onlineUsers", (list) => {
  onlineList.innerHTML = "";
  (list || []).forEach(({ user }) => {
    const row = document.createElement("div");
    row.className = "userRow";
    row.innerHTML = `<div class="userName">${escapeHTML(user)}</div><div class="userTag">online</div>`;

    // click online user:
    // - in DMs tab => open DM (guests can't DM)
    // - otherwise => open profile
    row.addEventListener("click", () => {
      if (view.type === "dms" && !me.guest) {
        if (/^Guest\d{4,5}$/.test(user)) {
          showToast("Not available", "You can’t DM guest users.");
          return;
        }
        view.withUser = user;
        setChatHeader(`DM: ${user}`, "Direct messages");
        clearMessages();
        socket.emit("dm:history", { withUser: user });
      } else {
        socket.emit("profile:get", { user });
      }
    });

    onlineList.appendChild(row);
  });
});

socket.on("history", (msgs) => {
  clearMessages();
  (msgs || []).forEach(addMessage);
});

socket.on("globalMessage", (msg) => {
  if (view.type !== "global") return;
  addMessage(msg);
});

socket.on("dm:history", ({ msgs } = {}) => {
  clearMessages();
  (msgs || []).forEach(addMessage);
});
socket.on("dm:message", ({ from, msg } = {}) => {
  // If currently viewing that DM, show it
  if (view.type === "dms" && view.withUser && from === view.withUser) {
    addMessage(msg);
    return;
  }
  // Otherwise ping (no red ping for global, but yes for DMs)
  ping();
});

socket.on("groups:list", (groups) => {
  // Keep it simple: click a group from toasts/inbox; list UI is future
  // (You asked to avoid unnecessary stuff)
});

socket.on("group:history", ({ msgs, meta } = {}) => {
  clearMessages();
  if (meta?.name) setChatHeader(`GC: ${meta.name}`, `${(meta.members || []).length} members`);
  (msgs || []).forEach(addMessage);
});
socket.on("group:message", ({ groupId, msg } = {}) => {
  if (view.type === "groups" && view.groupId === groupId) {
    addMessage(msg);
  } else {
    ping();
  }
});

socket.on("social:update", (social) => {
  // friend reqs + group invites only
  const fr = social?.incoming || [];
  const gi = social?.groupInvites || [];

  renderFriendRequests(fr);
  renderGroupInvites(gi);

  const totalInbox = fr.length + gi.length;
  inboxBadge.hidden = totalInbox <= 0;
  inboxBadge.textContent = String(totalInbox);
});

socket.on("ping:update", ({ messages } = {}) => {
  // pills only for DMs/GCs (global no red)
  const n = Number(messages || 0);
  const show = n > 0;
  dmPill.hidden = !show;
  gcPill.hidden = !show;
  dmPill.textContent = String(n);
  gcPill.textContent = String(n);
});

socket.on("xp:update", (xp) => updateXP(xp));

socket.on("profile:data", (p) => {
  if (!p || p.missing) {
    showToast("Profile", "User not found.");
    return;
  }
  if (p.guest) {
    showToast("Guest user", p.user);
    return;
  }

  const created = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : "—";
  showToast(p.user, `Created: ${created} • Level ${p.level} • Messages: ${p.messages}`);
});

// ---- XP UI + level up toast ----
function updateXP(xp) {
  if (!xp || me.guest) return;

  const level = xp.level ?? 1;
  const cur = xp.xp ?? 0;
  const next = xp.next ?? 120;

  meLevel.hidden = false;
  meLevel.textContent = `Lv ${level}`;

  xpLabel.textContent = `Level ${level}`;
  xpNums.textContent = `${cur} / ${next}`;

  const pct = next > 0 ? Math.max(0, Math.min(100, (cur / next) * 100)) : 0;
  xpFill.style.width = `${pct}%`;

  if (lastXP && level > lastXP.level) {
    ping();
    showToast("Level up!", `You reached Level ${level}.`);
  }
  lastXP = { level, xp: cur, next };
}

// ---- Inbox rendering ----
function renderFriendRequests(list) {
  friendRequestsEl.innerHTML = "";
  if (!list.length) {
    friendRequestsEl.innerHTML = `<div class="hint">No friend requests.</div>`;
    return;
  }
  list.forEach((u) => {
    const row = document.createElement("div");
    row.className = "settingRow";
    row.innerHTML = `
      <div class="settingText">
        <div class="settingName">${escapeHTML(u)}</div>
        <div class="settingDesc">Wants to add you.</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn primary">Accept</button>
        <button class="btn">Decline</button>
      </div>
    `;
    const [acceptBtn, declineBtn] = row.querySelectorAll("button");
    acceptBtn.addEventListener("click", () => socket.emit("friend:accept", { from: u }));
    declineBtn.addEventListener("click", () => socket.emit("friend:decline", { from: u }));
    friendRequestsEl.appendChild(row);
  });
}

function renderGroupInvites(list) {
  groupInvitesEl.innerHTML = "";
  if (!list.length) {
    groupInvitesEl.innerHTML = `<div class="hint">No group invites.</div>`;
    return;
  }
  list.forEach((inv) => {
    const row = document.createElement("div");
    row.className = "settingRow";
    row.innerHTML = `
      <div class="settingText">
        <div class="settingName">${escapeHTML(inv.groupName || "Unnamed Group")}</div>
        <div class="settingDesc">Invite from ${escapeHTML(inv.from || "?" )}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn primary">Join</button>
        <button class="btn">Decline</button>
      </div>
    `;
    const [joinBtn, declineBtn] = row.querySelectorAll("button");
    joinBtn.addEventListener("click", () => {
      // switch to groups view + load history after accept
      socket.emit("group:invite:accept", { groupId: inv.groupId });
      view = { type: "groups", groupId: inv.groupId, withUser: null };
      setActiveTab("groups");
      setChatHeader(`GC: ${inv.groupName || "Unnamed Group"}`, "Loading…");
      clearMessages();
      closeModals();
      setTimeout(() => socket.emit("group:history", { groupId: inv.groupId }), 200);
    });
    declineBtn.addEventListener("click", () => socket.emit("group:invite:decline", { groupId: inv.groupId }));
    groupInvitesEl.appendChild(row);
  });
}
