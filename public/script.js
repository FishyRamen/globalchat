const socket = io();
const $ = (id) => document.getElementById(id);

/* ---------- DOM ---------- */
const sidebar = $("sidebar");
const loginSection = $("login");
const chatSection = $("chat");
const connLine = $("connLine");

const usernameIn = $("username");
const passwordIn = $("password");
const loginBtn = $("loginBtn");

const meDot = $("meDot");
const meName = $("meName");
const meTag = $("meTag");

const convosList = $("convosList");
const onlineList = $("onlineList");

const inboxBtn = $("inboxBtn");
const inboxBadge = $("inboxBadge");
const settingsBtn = $("settingsBtn");
const authBtn = $("authBtn");

const createGroupBtn = $("createGroupBtn");

const chatModeTitle = $("chatModeTitle");
const backBtn = $("backBtn");
const groupManageBtn = $("groupManageBtn");

const chatBox = $("chatBox");
const msgIn = $("message");
const sendBtn = $("sendBtn");

/* emoji */
const emojiBtn = $("emojiBtn");
const emojiPanel = $("emojiPanel");
const emojiGrid = $("emojiGrid");

/* modals */
const settingsOverlay = $("settingsOverlay");
const settingsGrid = $("settingsGrid");
const settingsSub = $("settingsSub");
const settingsClose = $("settingsClose");
const settingsSave = $("settingsSave");

const inboxOverlay = $("inboxOverlay");
const inboxGrid = $("inboxGrid");
const inboxClose = $("inboxClose");

const groupOverlay = $("groupOverlay");
const groupFriendPick = $("groupFriendPick");
const groupClose = $("groupClose");
const groupName = $("groupName");
const groupCreateConfirm = $("groupCreateConfirm");

const groupManageOverlay = $("groupManageOverlay");
const gmTitle = $("gmTitle");
const gmSub = $("gmSub");
const gmRename = $("gmRename");
const gmRenameBtn = $("gmRenameBtn");
const gmInviteGrid = $("gmInviteGrid");
const gmMembersGrid = $("gmMembersGrid");
const gmClose = $("gmClose");
const gmDelete = $("gmDelete");

/* context menu */
const ctxMenu = $("ctxMenu");
const ctxTitle = $("ctxTitle");
const ctxMuteToggle = $("ctxMuteToggle");

/* toasts */
const toastWrap = $("toastWrap");

/* ---------- state ---------- */
let currentUser = null;
let currentColor = "white";
let guest = false;

let state = {
  me: null,
  settings: {},
  mutes: { muteAll: false, global: false, dm: {}, group: {} },
  friends: [],
  conversations: [],
  groups: [],
  inbox: [],
};

let view = { mode: "global", dmWith: null, groupId: null };
let globalMessages = [];
let dmMessages = [];
let groupMessages = [];

let lastSendGlobal = 0;

/* ---------- helpers ---------- */
function escapeHTML(s){
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])
  );
}
function fmtTime(ts){
  if (!ts || typeof ts !== "number" || !isFinite(ts) || ts <= 0) return "";
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}
function toast(title, text, ms=2200){
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `
    <div class="top">
      <div class="t">${escapeHTML(title)}</div>
      <div class="x">×</div>
    </div>
    <div class="p">${escapeHTML(text)}</div>
  `;
  t.querySelector(".x").onclick = () => t.remove();
  toastWrap.appendChild(t);
  setTimeout(()=>{ t.remove(); }, ms);
}

/* ---------- mute logic ---------- */
function isMuted(kind, id){
  const m = state.mutes || { muteAll:false, global:false, dm:{}, group:{} };
  if (m.muteAll) return true;
  if (kind === "global") return !!m.global;
  if (kind === "dm") return !!m.dm?.[id];
  if (kind === "group") return !!m.group?.[id];
  return false;
}

function toggleMute(kind, id){
  const m = structuredClone(state.mutes || { muteAll:false, global:false, dm:{}, group:{} });
  if (kind === "global"){
    m.global = !m.global;
  } else if (kind === "dm"){
    m.dm = m.dm || {};
    m.dm[id] = !m.dm[id];
  } else if (kind === "group"){
    m.group = m.group || {};
    m.group[id] = !m.group[id];
  }
  state.mutes = m;
  socket.emit("updateMutes", m);
  renderConversations();
  toast("Mute", isMuted(kind,id) ? "Muted." : "Unmuted.", 1600);
}

/* ---------- simple ping ---------- */
let audioCtx = null;
function ping(){
  if (guest) return;
  if (isMuted(view.mode === "global" ? "global" : view.mode, view.mode === "dm" ? view.dmWith : view.groupId)) {
    // only mute applies to incoming pings; this check is for current view anyway
  }
  if (state.mutes?.muteAll) return;

  try{
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = audioCtx;
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    const g = ctx.createGain();

    o1.type = "sine";
    o2.type = "triangle";
    o1.frequency.value = 740;
    o2.frequency.value = 930;

    const vol = Math.max(0.01, Number(state.settings?.volume ?? 0.22));
    g.gain.value = 0.0001;

    o1.connect(g); o2.connect(g); g.connect(ctx.destination);

    const t0 = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);

    o1.start(t0);
    o2.start(t0 + 0.02);
    o1.stop(t0 + 0.16);
    o2.stop(t0 + 0.16);
  }catch{}
}

/* ---------- UI switching ---------- */
function showLogin(){
  chatSection.style.display = "none";
  loginSection.style.display = "flex";
  sidebar.style.display = "none";
}
function showChat(){
  loginSection.style.display = "none";
  chatSection.style.display = "flex";
  sidebar.style.display = "flex";
}

/* ---------- view switching ---------- */
function setViewGlobal(){
  view = { mode:"global", dmWith:null, groupId:null };
  chatModeTitle.textContent = "Global Chat";
  backBtn.style.display = "none";
  groupManageBtn.style.display = "none";
  renderChat();
  renderConversations();
}
function setViewDM(user){
  view = { mode:"dm", dmWith:user, groupId:null };
  chatModeTitle.textContent = `Messaging: ${user}`;
  backBtn.style.display = "inline-flex";
  groupManageBtn.style.display = "none";
  renderChat();
  renderConversations();
}
function setViewGroup(group){
  view = { mode:"group", dmWith:null, groupId:group.id };
  chatModeTitle.textContent = `Group: ${group.name}`;
  backBtn.style.display = "inline-flex";

  // OWNER ONLY can see Manage button
  const isOwner = (group.owner === currentUser);
  groupManageBtn.style.display = (!guest && isOwner) ? "inline-flex" : "none";

  renderChat();
  renderConversations();
}

/* ---------- rendering ---------- */
function addMsg({ user, text, ts, color, you=false }){
  // drop invalid timestamps
  if (!ts || typeof ts !== "number" || !isFinite(ts) || ts <= 0) return;

  const div = document.createElement("div");
  div.className = "msg" + (you ? " you" : "");
  div.innerHTML = `
    <div class="msg-top">
      <div class="msg-user" style="color:${escapeHTML(color || "white")}">${escapeHTML(user)}</div>
      <div class="msg-time">${escapeHTML(fmtTime(ts))}</div>
    </div>
    <div class="msg-text">${escapeHTML(text)}</div>
  `;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function renderChat(){
  chatBox.innerHTML = "";

  if (view.mode === "global"){
    globalMessages.forEach(m => addMsg({ user:m.user, text:m.text, ts:m.ts, color:m.color, you:m.user===currentUser }));
    return;
  }

  if (view.mode === "dm"){
    dmMessages.forEach(m => addMsg({
      user:m.from,
      text:m.text,
      ts:m.ts,
      color:m.colors?.[m.from] || (m.from===currentUser ? currentColor : "white"),
      you:m.from===currentUser
    }));
    return;
  }

  if (view.mode === "group"){
    groupMessages.forEach(m => addMsg({
      user:m.from,
      text:m.text,
      ts:m.ts,
      color:m.colors?.[m.from] || "white",
      you:m.from===currentUser
    }));
    return;
  }
}

function openButtonLabel(kind, id){
  if (view.mode === "global" && kind === "global") return { txt:"Opened", opened:true };
  if (view.mode === "dm" && kind === "dm" && view.dmWith === id) return { txt:"Opened", opened:true };
  if (view.mode === "group" && kind === "group" && view.groupId === id) return { txt:"Opened", opened:true };
  return { txt:"Open", opened:false };
}

function hideCtx(){ ctxMenu.style.display = "none"; ctxMenu.dataset.kind = ""; ctxMenu.dataset.id = ""; }
window.addEventListener("click", hideCtx);
window.addEventListener("scroll", hideCtx);

function showCtx(x, y, kind, id, title){
  ctxTitle.textContent = title;
  const muted = isMuted(kind, id);
  ctxMuteToggle.textContent = muted ? "Unmute notifications" : "Mute notifications";
  ctxMenu.dataset.kind = kind;
  ctxMenu.dataset.id = id;

  ctxMenu.style.left = Math.min(x, window.innerWidth - 240) + "px";
  ctxMenu.style.top = Math.min(y, window.innerHeight - 120) + "px";
  ctxMenu.style.display = "block";
}

ctxMuteToggle.addEventListener("click", () => {
  const kind = ctxMenu.dataset.kind;
  const id = ctxMenu.dataset.id;
  toggleMute(kind, id);
  hideCtx();
});

function renderConversations(){
  convosList.innerHTML = "";

  // Global row (right-clickable)
  {
    const lab = openButtonLabel("global");
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="left">
        <div class="dot"></div>
        <div style="min-width:0;">
          <div class="name">Global Chat</div>
          <div class="small">${guest ? "guest mode" : (isMuted("global") ? "muted" : "everyone")}</div>
        </div>
      </div>
      <button class="btn-mini ${lab.opened ? "opened":""}" ${lab.opened ? "disabled":""}>${lab.txt}</button>
    `;
    row.querySelector("button").onclick = () => setViewGlobal();
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showCtx(e.clientX, e.clientY, "global", "", "Global Chat");
    });
    convosList.appendChild(row);
  }

  if (guest) return;

  const convos = state.conversations || [];
  convos.forEach(c => {
    const lab = openButtonLabel(c.kind, c.id);
    const muted = isMuted(c.kind, c.id);

    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="left">
        <div class="dot"></div>
        <div style="min-width:0;">
          <div class="name">${escapeHTML(c.name)}</div>
          <div class="small">${c.kind === "group" ? (muted ? "group · muted" : "group chat") : (muted ? "dm · muted" : "direct message")}</div>
        </div>
      </div>
      <button class="btn-mini ${lab.opened ? "opened":""}" ${lab.opened ? "disabled":""}>${lab.txt}</button>
    `;

    row.querySelector("button").onclick = () => {
      if (lab.opened) return;
      if (c.kind === "dm") socket.emit("openDM", { withUser: c.id });
      else socket.emit("openGroup", { groupId: c.id });
    };

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showCtx(e.clientX, e.clientY, c.kind, c.id, c.kind === "group" ? `Group: ${c.name}` : `DM: ${c.name}`);
    });

    convosList.appendChild(row);
  });
}

function renderOnline(list){
  onlineList.innerHTML = "";
  (list || []).forEach(u => {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <div class="left">
        <div class="dot"></div>
        <div style="min-width:0;">
          <div class="name" style="color:${escapeHTML(u.color)}">${escapeHTML(u.user)}</div>
          <div class="small">${u.guest ? "guest" : "online"}</div>
        </div>
      </div>
      <button class="btn-mini">${guest ? "Login" : "Add"}</button>
    `;
    const btn = row.querySelector("button");

    if (u.user === currentUser){
      btn.textContent = "You";
      btn.disabled = true;
    } else if (guest){
      btn.onclick = () => toast("Guest mode", "Log in to add friends.", 2000);
    } else {
      btn.onclick = () => socket.emit("sendFriendRequest", { user: u.user });
    }
    onlineList.appendChild(row);
  });
}

/* ---------- settings modal ---------- */
function toggleRow(key, label, desc, value){
  const row = document.createElement("div");
  row.className = "toggle";
  row.innerHTML = `
    <div>
      <div class="lbl">${escapeHTML(label)}</div>
      <div class="desc">${escapeHTML(desc)}</div>
    </div>
    <div class="switch ${value ? "on":""}" data-k="${escapeHTML(key)}"></div>
  `;
  row.querySelector(".switch").addEventListener("click", (e) => {
    e.currentTarget.classList.toggle("on");
  });
  return row;
}

function sliderRow(key, label, desc, value){
  const row = document.createElement("div");
  row.className = "toggle";
  row.innerHTML = `
    <div>
      <div class="lbl">${escapeHTML(label)}</div>
      <div class="desc">${escapeHTML(desc)}</div>
    </div>
    <div style="display:flex; align-items:center; gap:10px;">
      <input type="range" min="0" max="0.35" step="0.01" value="${Number(value || 0.22)}" data-k="${escapeHTML(key)}" style="width:170px;">
      <div style="font-weight:900; font-size:12px; color:rgba(255,255,255,.70); width:46px; text-align:right;" class="pct">${Math.round((value||0.22)*100)}%</div>
    </div>
  `;
  const range = row.querySelector("input");
  const pct = row.querySelector(".pct");
  range.addEventListener("input", () => pct.textContent = `${Math.round(Number(range.value)*100)}%`);
  return row;
}

function openSettings(){
  settingsSub.textContent = guest ? "Guest has limited settings." : "Saved to your account.";
  settingsGrid.innerHTML = "";

  // Mute-all replaces separate DM/global settings you didn’t like
  settingsGrid.appendChild(toggleRow("muteAll", "Mute all notifications", "Disables pings for everything.", !!state.mutes?.muteAll));
  settingsGrid.appendChild(sliderRow("volume", "Volume", "Ping loudness.", state.settings?.volume ?? 0.22));

  settingsOverlay.style.display = "flex";
}
function closeSettings(){ settingsOverlay.style.display = "none"; }

function saveSettings(){
  // Only volume is in settings; muteAll is in mutes
  const s = { ...(state.settings || {}) };
  const m = structuredClone(state.mutes || { muteAll:false, global:false, dm:{}, group:{} });

  settingsGrid.querySelectorAll(".switch").forEach(sw => {
    const k = sw.getAttribute("data-k");
    if (k === "muteAll") m.muteAll = sw.classList.contains("on");
  });
  settingsGrid.querySelectorAll('input[type="range"]').forEach(r => {
    const k = r.getAttribute("data-k");
    s[k] = Number(r.value);
  });

  state.settings = s;
  state.mutes = m;

  if (!guest) {
    socket.emit("updateSettings", s);
    socket.emit("updateMutes", m);
  }

  toast("Saved", "Settings updated.", 1600);
  closeSettings();
}

/* ---------- inbox ---------- */
function setInboxBadge(n){
  const show = n > 0;
  inboxBadge.style.display = show ? "inline-flex" : "none";
  inboxBadge.textContent = String(n);
}
function openInbox(){
  if (guest) { toast("Guest mode", "Log in to use Inbox.", 2000); return; }
  socket.emit("getInbox");
  inboxOverlay.style.display = "flex";
}
function closeInbox(){ inboxOverlay.style.display = "none"; }

function renderInbox(items){
  inboxGrid.innerHTML = "";
  items = Array.isArray(items) ? items : [];

  if (items.length === 0){
    const div = document.createElement("div");
    div.className = "toggle";
    div.innerHTML = `<div><div class="lbl">No notifications</div><div class="desc">You're all caught up.</div></div>`;
    inboxGrid.appendChild(div);
    return;
  }

  items.forEach(item => {
    if (item.type === "friend_request"){
      const row = document.createElement("div");
      row.className = "toggle";
      row.innerHTML = `
        <div>
          <div class="lbl">Friend request</div>
          <div class="desc">${escapeHTML(item.from)} wants to add you.</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn primary" data-a="acc">Accept</button>
          <button class="btn" data-a="dec">Decline</button>
        </div>
      `;
      row.querySelector('[data-a="acc"]').onclick = () => socket.emit("acceptFriendRequest", { from: item.from });
      row.querySelector('[data-a="dec"]').onclick = () => socket.emit("declineFriendRequest", { from: item.from });
      inboxGrid.appendChild(row);
    }

    if (item.type === "group_invite"){
      const row = document.createElement("div");
      row.className = "toggle";
      row.innerHTML = `
        <div>
          <div class="lbl">Group invite</div>
          <div class="desc">${escapeHTML(item.from)} invited you to <b>${escapeHTML(item.name || "a group")}</b>.</div>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn primary" data-a="acc">Join</button>
          <button class="btn" data-a="dec">Decline</button>
        </div>
      `;
      row.querySelector('[data-a="acc"]').onclick = () => socket.emit("acceptGroupInvite", { groupId: item.groupId });
      row.querySelector('[data-a="dec"]').onclick = () => socket.emit("declineGroupInvite", { groupId: item.groupId });
      inboxGrid.appendChild(row);
    }
  });
}

/* ---------- group create/manage ---------- */
let groupPick = new Set();

function openGroupCreate(){
  if (guest){ toast("Guest mode", "Log in to create groups.", 2000); return; }
  groupPick = new Set();
  groupName.value = "";
  renderGroupFriendPick();
  groupOverlay.style.display = "flex";
}
function closeGroupCreate(){ groupOverlay.style.display = "none"; }

function renderGroupFriendPick(){
  groupFriendPick.innerHTML = "";
  const friends = state.friends || [];
  if (friends.length === 0){
    const d = document.createElement("div");
    d.className = "toggle";
    d.innerHTML = `<div><div class="lbl">No friends yet</div><div class="desc">Add friends first to create a group.</div></div>`;
    groupFriendPick.appendChild(d);
    return;
  }

  friends.forEach(f => {
    const row = document.createElement("div");
    row.className = "toggle";
    row.innerHTML = `
      <div>
        <div class="lbl">${escapeHTML(f)}</div>
        <div class="desc">Invite to group</div>
      </div>
      <div class="switch ${groupPick.has(f) ? "on":""}"></div>
    `;
    const sw = row.querySelector(".switch");
    sw.onclick = () => {
      if (groupPick.has(f)) groupPick.delete(f); else groupPick.add(f);
      sw.classList.toggle("on");
    };
    groupFriendPick.appendChild(row);
  });
}

function openGroupManage(){
  if (guest) return;
  if (view.mode !== "group") return;

  const g = (state.groups || []).find(x => x.id === view.groupId);
  if (!g) { toast("Group", "Group not found.", 2000); return; }

  // OWNER ONLY UI
  if (g.owner !== currentUser){
    toast("Group", "Only the owner can manage this group.", 2200);
    return;
  }

  gmTitle.textContent = `Manage: ${g.name}`;
  gmSub.textContent = "Owner controls.";
  gmRename.value = "";

  gmInviteGrid.innerHTML = "";
  const friends = state.friends || [];
  const inviteCandidates = friends.filter(f => !g.members.includes(f));
  if (inviteCandidates.length === 0){
    const d = document.createElement("div");
    d.className = "toggle";
    d.innerHTML = `<div><div class="lbl">No friends to invite</div><div class="desc">Add more friends first.</div></div>`;
    gmInviteGrid.appendChild(d);
  } else {
    inviteCandidates.forEach(f => {
      const row = document.createElement("div");
      row.className = "toggle";
      row.innerHTML = `
        <div>
          <div class="lbl">${escapeHTML(f)}</div>
          <div class="desc">Invite to group</div>
        </div>
        <button class="btn primary" style="white-space:nowrap;">Invite</button>
      `;
      row.querySelector("button").onclick = () => {
        socket.emit("groupManage", { groupId: g.id, action: "invite", user: f });
        toast("Invite sent", `Invited ${f}.`, 1600);
      };
      gmInviteGrid.appendChild(row);
    });
  }

  gmMembersGrid.innerHTML = "";
  g.members.forEach(m => {
    const row = document.createElement("div");
    row.className = "toggle";
    const role = (m === g.owner) ? "owner" : "member";
    row.innerHTML = `
      <div>
        <div class="lbl">${escapeHTML(m)} ${m === currentUser ? "(you)" : ""}</div>
        <div class="desc">${role}</div>
      </div>
      <div style="display:flex; gap:8px;">
        <button class="btn" data-a="transfer" style="white-space:nowrap;">Make owner</button>
        <button class="btn" data-a="remove" style="white-space:nowrap;border-color: rgba(239,68,68,.28);">Remove</button>
      </div>
    `;
    const transfer = row.querySelector('[data-a="transfer"]');
    const remove = row.querySelector('[data-a="remove"]');

    transfer.disabled = (m === g.owner);
    remove.disabled = (m === g.owner) || (m === currentUser);

    transfer.onclick = () => socket.emit("groupManage", { groupId: g.id, action: "transferOwner", user: m });
    remove.onclick = () => socket.emit("groupManage", { groupId: g.id, action: "remove", user: m });

    gmMembersGrid.appendChild(row);
  });

  groupManageOverlay.style.display = "flex";
}

function closeGroupManage(){ groupManageOverlay.style.display = "none"; }

/* ---------- emoji picker ---------- */
const EMOJIS = ["😀","😁","😂","🤣","😊","😍","😘","😎","😅","🙂","🤔","😴","😭","😤","😡","🤯",
                "👍","👎","👏","🙏","🔥","💀","💯","✨","🎉","❤️","💔","😈","😇","🤝","🫡","🤨",
                "😮","😱","🥶","🥵","🤡","🧠","👀","🙌","🤍","🖤","🎶","📌","✅","❌","⚡","🌙"];

function buildEmojiGrid(){
  emojiGrid.innerHTML = "";
  EMOJIS.forEach(e => {
    const cell = document.createElement("div");
    cell.className = "emojiCell";
    cell.textContent = e;
    cell.onclick = () => {
      msgIn.value += e;
      msgIn.focus();
    };
    emojiGrid.appendChild(cell);
  });
}
buildEmojiGrid();

emojiBtn.onclick = () => {
  emojiPanel.style.display = (emojiPanel.style.display === "block") ? "none" : "block";
};
window.addEventListener("click", (e) => {
  if (!emojiPanel.contains(e.target) && e.target !== emojiBtn) emojiPanel.style.display = "none";
});

/* ---------- actions ---------- */
function login(){
  const user = usernameIn.value.trim();
  const pass = passwordIn.value;
  socket.emit("login", { user, pass });
}
function logout(){ location.reload(); }

function sendMessage(){
  const text = msgIn.value.trim();
  if (!text) return;

  if (view.mode === "global"){
    const t = Date.now();
    if (t - lastSendGlobal < 3000){
      toast("Cooldown", "Wait 3 seconds.", 1600);
      return;
    }
    lastSendGlobal = t;
    socket.emit("chat", { text });
    msgIn.value = "";
    return;
  }

  if (guest){
    toast("Guest mode", "Log in to use DMs/groups.", 2000);
    return;
  }

  if (view.mode === "dm"){
    socket.emit("sendDM", { to: view.dmWith, text });
    msgIn.value = "";
    return;
  }

  if (view.mode === "group"){
    socket.emit("sendGroup", { groupId: view.groupId, text });
    msgIn.value = "";
    return;
  }
}

loginBtn.onclick = login;
sendBtn.onclick = sendMessage;
authBtn.onclick = () => guest ? (showLogin()) : logout();
settingsBtn.onclick = openSettings;
inboxBtn.onclick = openInbox;
createGroupBtn.onclick = openGroupCreate;

backBtn.onclick = () => setViewGlobal();
groupManageBtn.onclick = openGroupManage;

settingsClose.onclick = closeSettings;
settingsOverlay.onclick = (e) => { if (e.target === settingsOverlay) closeSettings(); };
settingsSave.onclick = saveSettings;

inboxClose.onclick = closeInbox;
inboxOverlay.onclick = (e) => { if (e.target === inboxOverlay) closeInbox(); };

groupClose.onclick = closeGroupCreate;
groupOverlay.onclick = (e) => { if (e.target === groupOverlay) closeGroupCreate(); };
groupCreateConfirm.onclick = () => {
  const name = groupName.value.trim();
  const members = Array.from(groupPick);
  if (members.length === 0){
    toast("Pick members", "Choose at least one friend.", 1800);
    return;
  }
  socket.emit("createGroup", { name, members });
  toast("Sent", "Group invites sent to Inbox.", 2000);
  closeGroupCreate();
};

gmClose.onclick = closeGroupManage;
groupManageOverlay.onclick = (e) => { if (e.target === groupManageOverlay) closeGroupManage(); };

gmRenameBtn.onclick = () => {
  const g = (state.groups || []).find(x => x.id === view.groupId);
  if (!g) return;
  const newName = gmRename.value.trim();
  if (!newName){ toast("Rename", "Enter a name first.", 1600); return; }
  socket.emit("groupManage", { groupId: g.id, action: "rename", name: newName });
  toast("Renamed", "Group name updated.", 1600);
  closeGroupManage();
};

gmDelete.onclick = () => {
  const g = (state.groups || []).find(x => x.id === view.groupId);
  if (!g) return;
  socket.emit("groupManage", { groupId: g.id, action: "delete" });
  toast("Deleted", "Group removed.", 1800);
  closeGroupManage();
  setViewGlobal();
};

/* ---------- socket handlers ---------- */
socket.on("connect", () => { connLine.textContent = "Connected. Log in or join as guest."; });

socket.on("loginError", (msg) => toast("Login failed", msg || "Try again.", 2600));

socket.on("loginSuccess", (data) => {
  currentUser = data.user;
  currentColor = data.color || "white";
  guest = !!data.guest;

  // left identity
  meName.textContent = currentUser;
  meTag.textContent = guest ? "guest" : "online";
  meDot.classList.toggle("grey", false);

  // guest mode disables inbox/groups
  inboxBtn.style.display = guest ? "none" : "block";
  createGroupBtn.style.display = guest ? "none" : "inline-flex";
  authBtn.textContent = guest ? "Log in" : "Log out";

  showChat();
  setViewGlobal();
  toast("Welcome", guest ? "Guest mode: Global only." : "Logged in.", 1800);
});

socket.on("state", (st) => {
  // full state refresh (instant group owner changes)
  state = { ...state, ...(st || {}) };
  setInboxBadge((state.inbox || []).length);
  renderInbox(state.inbox || []);
  renderConversations();

  // If we are currently in a group view, update manage button visibility instantly:
  if (view.mode === "group"){
    const g = (state.groups || []).find(x => x.id === view.groupId);
    if (g) groupManageBtn.style.display = (!guest && g.owner === currentUser) ? "inline-flex" : "none";
  }
});

socket.on("history", (msgs) => {
  globalMessages = (msgs || []).filter(m => m && typeof m.ts === "number" && isFinite(m.ts) && m.ts > 0);
  if (view.mode === "global") renderChat();
});

socket.on("chat", (m) => {
  if (!m || typeof m.ts !== "number" || !isFinite(m.ts) || m.ts <= 0) return;
  globalMessages.push(m);
  if (globalMessages.length > 800) globalMessages = globalMessages.slice(-800);
  if (view.mode === "global"){
    addMsg({ user:m.user, text:m.text, ts:m.ts, color:m.color, you:m.user===currentUser });
    // default: global pings are OFF unless user unmutes global
    if (!isMuted("global") && !state.mutes?.muteAll && state.mutes?.global === false) {
      // BUT: you asked default global ping off → we will not ping here at all
    }
  }
});

socket.on("onlineUsers", (list) => {
  renderOnline(list || []);
});

socket.on("inbox", (items) => {
  state.inbox = Array.isArray(items) ? items : [];
  setInboxBadge(state.inbox.length);
  renderInbox(state.inbox);
});

socket.on("friendRequestSent", ({ to }) => toast("Request sent", `Sent to ${to}.`, 1700));
socket.on("friendAccepted", ({ user }) => toast("Friend added", `${user} accepted.`, 2200));
socket.on("friendDeclined", ({ user }) => toast("Declined", `${user} declined.`, 2000));

socket.on("dmError", (msg) => toast("DM", msg || "DM blocked.", 2400));

socket.on("dmHistory", (data) => {
  dmMessages = (data.msgs || []).filter(m => m && typeof m.ts === "number" && isFinite(m.ts) && m.ts > 0)
    .map(m => ({ ...m, colors: data.colors || {} }));
  setViewDM(data.withUser);
  renderChat();
});

socket.on("dm", (m) => {
  if (!m || typeof m.ts !== "number" || !isFinite(m.ts) || m.ts <= 0) return;
  const other = (m.from === currentUser) ? m.to : m.from;

  if (view.mode === "dm" && view.dmWith === other){
    dmMessages.push(m);
    addMsg({
      user:m.from,
      text:m.text,
      ts:m.ts,
      color: m.colors?.[m.from] || (m.from===currentUser ? currentColor : "white"),
      you: m.from===currentUser
    });
  } else {
    // ping if not muted
    if (!isMuted("dm", other)) ping();
  }
});

socket.on("groupError", (msg) => toast("Group", msg || "Blocked.", 2400));

socket.on("groupHistory", (data) => {
  const g = data?.group;
  if (!g) return;
  groupMessages = (data.msgs || []).filter(m => m && typeof m.ts === "number" && isFinite(m.ts) && m.ts > 0)
    .map(m => ({ ...m, colors: data.colors || {} }));
  setViewGroup(g);
  renderChat();
});

socket.on("groupMsg", (m) => {
  if (!m || typeof m.ts !== "number" || !isFinite(m.ts) || m.ts <= 0) return;

  if (view.mode === "group" && view.groupId === m.groupId){
    groupMessages.push(m);
    addMsg({ user:m.from, text:m.text, ts:m.ts, color:m.colors?.[m.from] || "white", you:m.from===currentUser });
  } else {
    // ping for group chats (you asked), unless muted
    if (!isMuted("group", m.groupId)) ping();
  }
});

socket.on("groupMeta", (meta) => {
  // instant update while open
  if (view.mode === "group" && meta?.id === view.groupId){
    chatModeTitle.textContent = `Group: ${meta.name}`;
    // manage button owner-only
    groupManageBtn.style.display = (!guest && meta.owner === currentUser) ? "inline-flex" : "none";
  }
});

/* ---------- start ---------- */
showLogin();
setViewGlobal();
