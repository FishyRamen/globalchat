/* public/script.js
   - Works with your current index.html IDs (the version you pasted earlier).
   - No alerts: uses modal + toasts only.
   - Fixes: modals closable, login/resume on refresh, settings preview doesn’t “save” until you press Save,
            messages sidebar shows Global + your DMs + your groups (no subtabs),
            inbox shows friend requests + group invites in one list (no sections),
            group creation uses invites-required flow (group:createRequest) but also supports older group:create fallback.
*/

const socket = io();
const $ = (id) => document.getElementById(id);

// ------------------------- UI refs (defensive) -------------------------
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

// Footer year
const yearEl = $("year");
if (yearEl) yearEl.textContent = String(new Date().getFullYear());

// Safety: if a previous broken state left overlays visible, reset
if (modalBack) modalBack.classList.remove("show");
if (loading) loading.classList.remove("show");

// ------------------------- State -------------------------
let me = null;
let isGuest = false;
let token = localStorage.getItem("tonkotsu_token") || null;

let onlineUsers = [];            // [{user}]
let settings = null;             // from server (non-guest)
let social = null;               // from server (non-guest)
let xp = null;                   // from server (non-guest), or null for guest

let view = { type: "global", id: null };  // global | dm | group
let currentDM = null;
let currentGroupId = null;

// caches
let globalCache = [];
let dmCache = new Map();         // user -> msgs
let groupMeta = new Map();       // gid -> {id,name,owner,members[]}
let groupCache = new Map();      // gid -> msgs

// pings
let unreadDM = new Map();        // user -> count
let unreadGroup = new Map();     // gid -> count
let mentions = [];               // local mentions for inbox: [{from, scope, ts, text}]
let lastSeenGlobalTs = 0;

// cooldown
let cooldownUntil = 0;

// mild profanity list (allowed but optionally hidden client-side)
const MILD_WORDS = [
  "fuck","fucking","shit","shitty","asshole","bitch","bastard","dick","pussy"
];
const MILD_RX = new RegExp(
  `\\b(${MILD_WORDS.map(w => w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})\\b`,
  "ig"
);

// ------------------------- Themes / Density (must exist in your HTML) -------------------------
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
  const pad = Math.round(8 + v * 10);   // 8..18
  const font = Math.round(12 + v * 2);  // 12..14
  const r = document.documentElement.style;
  r.setProperty("--pad", `${pad}px`);
  r.setProperty("--font", `${font}px`);
}

// ------------------------- Helpers -------------------------
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

function isGuestUser(u){ return /^Guest\d{4,5}$/.test(String(u)); }

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
  setTimeout(() => { d.style.opacity="0"; d.style.transform="translateY(10px)"; }, 2400);
  setTimeout(() => d.remove(), 2900);
}

function showLoading(text="syncing…"){
  const sub = $("loaderSub");
  if (sub) sub.textContent = text;
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
if (modalBack) modalBack.addEventListener("click", (e)=>{ if(e.target===modalBack) closeModal(); });

// ------------------------- Password toggle -------------------------
if (togglePass && passwordEl) {
  // Use symbols, not emoji (you asked for symbol)
  togglePass.textContent = "👁"; // if you want pure symbol: "◉" or "⌁"
  togglePass.addEventListener("click", () => {
    const isPw = passwordEl.type === "password";
    passwordEl.type = isPw ? "text" : "password";
    togglePass.textContent = isPw ? "🙈" : "👁";
  });
}

// ------------------------- Cooldown -------------------------
function cooldownSeconds(){
  return isGuest ? 5 : 3;
}
function canSend(){
  return now() >= cooldownUntil;
}
function startCooldown(){
  const secs = cooldownSeconds();
  cooldownUntil = now() + secs * 1000;
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
      cooldownRow.classList.remove("warn");
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
  setTimeout(()=> cooldownRow.classList.remove("shake"), 380);
  setTimeout(()=> cooldownRow.classList.remove("warn"), 900);
}

// ------------------------- View switching -------------------------
function setView(type, id=null){
  view = { type, id };
  socket.emit("view:set", view); // harmless even if server ignores

  if (!chatTitle || !chatHint || !backBtn) return;

  if (type === "global"){
    chatTitle.textContent = "Global chat";
    chatHint.textContent = "shared with everyone online";
    backBtn.style.display = "none";
  } else if (type === "dm"){
    chatTitle.textContent = `DM — ${id}`;
    chatHint.textContent = "private messages";
    backBtn.style.display = "inline-flex";
  } else if (type === "group"){
    const meta = groupMeta.get(id);
    chatTitle.textContent = meta ? `Group — ${meta.name}` : "Group";
    chatHint.textContent = "group chat";
    backBtn.style.display = "inline-flex";
  }
}

if (backBtn) backBtn.addEventListener("click", ()=> openGlobal(true));

// ------------------------- Rendering messages -------------------------
function fmtTime(ts){
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return null;
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

function renderTextWithMentions(text){
  // keep it simple: highlight @me only (no markdown)
  const safe = escapeHtml(text);
  if (!me) return safe;
  const rx = new RegExp(`(@${me.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")})`, "ig");
  return safe.replace(rx, `<span style="color:var(--warn);font-weight:900">$1</span>`);
}

function addMessageToUI({ user, text, ts }, { scope="global", from=null, groupId=null } = {}){
  const t = fmtTime(ts);
  if (!t || !chatBox) return;

  const who = (scope === "dm") ? from : user;

  let bodyText = String(text ?? "");
  if (bodyText === "__HIDDEN_BY_FILTER__") {
    bodyText = "Message hidden (filtered).";
  }

  // Block behavior:
  // - Global: hide blocked user messages (you can add an “unblur” later)
  // - DM/group: block should prevent DM on server; if it arrives, mask
  if (scope === "global" && isBlockedUser(who)) {
    bodyText = "Message hidden (blocked user).";
  } else {
    bodyText = maybeHideMild(bodyText);
  }

  const row = document.createElement("div");
  row.className = "msg";
  row.innerHTML = `
    <div class="bubble">
      <div class="meta">
        <div class="u" data-user="${escapeHtml(who)}">${escapeHtml(who)}${(who===me?" (You)":"")}</div>
        <div class="t">${t}</div>
      </div>
      <div class="body">${renderTextWithMentions(bodyText)}</div>
    </div>
  `;

  // click username -> profile popup
  const uEl = row.querySelector(".u");
  if (uEl) {
    uEl.addEventListener("click", (e)=>{
      const u = e.target.getAttribute("data-user");
      openProfile(u);
    });
  }

  chatBox.appendChild(row);
  chatBox.scrollTop = chatBox.scrollHeight;

  // Local mention tracking (for inbox + ping) — server does not store mentions in the provided backend
  if (scope === "global" && me && who !== me && !isGuest) {
    const raw = String(text ?? "");
    if (raw.toLowerCase().includes(`@${me.toLowerCase()}`)) {
      mentions.unshift({ from: who, scope: "Global chat", ts: ts || now(), text: raw.slice(0, 120) });
      mentions = mentions.slice(0, 80);
      bumpInboxPing();
    }
  }

  // Track “last seen” for global so you don’t endlessly ping yourself
  if (scope === "global") lastSeenGlobalTs = Math.max(lastSeenGlobalTs, Number(ts || 0));
}

function clearChat(){
  if (chatBox) chatBox.innerHTML = "";
}

// ------------------------- Sidebar render -------------------------
function renderSidebarGlobal(){
  if (!sideSection) return;

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

function totalMessagePings(){
  let n = 0;
  for (const v of unreadDM.values()) n += v;
  for (const v of unreadGroup.values()) n += v;
  return n;
}

function updateBadges(){
  // Messages badge = DM + group unread (no global)
  const m = totalMessagePings();
  if (msgPing){
    msgPing.textContent = String(m);
    msgPing.classList.toggle("show", m > 0);
  }

  // Inbox badge = friend requests + group invites + mentions (local)
  const friendCount = Array.isArray(social?.incoming) ? social.incoming.length : 0;
  const inviteCount = Array.isArray(window.__groupInvitesCache) ? window.__groupInvitesCache.length : 0;
  const mentionCount = mentions.length;
  const i = friendCount + inviteCount + mentionCount;

  if (inboxPing){
    inboxPing.textContent = String(i);
    inboxPing.classList.toggle("show", i > 0);
  }
}

function bumpInboxPing(){
  updateBadges();
}

function renderSidebarMessages(){
  if (!sideSection) return;

  // Build lists
  const dmUsers = Array.from(new Set(Array.from(dmCache.keys()))).sort((a,b)=>a.localeCompare(b));
  const groups = Array.from(groupMeta.values()).sort((a,b)=>String(a.name).localeCompare(String(b.name)));

  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Messages</div>
      <button class="btn small" id="createGroupBtn">Create group</button>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px" id="msgList">
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
        return `
          <div class="row" data-open="dm" data-id="${escapeHtml(u)}">
            <div class="rowLeft">
              <div class="statusDot ${onlineUsers.some(x=>x.user===u) ? "on":""}"></div>
              <div class="nameCol">
                <div class="rowName">${escapeHtml(u)}</div>
                <div class="rowSub">dm</div>
              </div>
            </div>
            ${c>0 ? `<div class="ping show">${c}</div>` : ``}
          </div>
        `;
      }).join("")}

      ${groups.map(g=>{
        const c = unreadGroup.get(g.id) || 0;
        return `
          <div class="row" data-open="group" data-id="${escapeHtml(g.id)}">
            <div class="rowLeft">
              <div class="statusDot on"></div>
              <div class="nameCol">
                <div class="rowName">${escapeHtml(g.name)}</div>
                <div class="rowSub">${escapeHtml(g.id)}</div>
              </div>
            </div>
            ${c>0 ? `<div class="ping show">${c}</div>` : ``}
          </div>
        `;
      }).join("")}
    </div>
  `;

  const msgList = $("msgList");
  if (msgList){
    msgList.querySelectorAll("[data-open]").forEach(row=>{
      row.addEventListener("click", ()=>{
        const t = row.getAttribute("data-open");
        const id = row.getAttribute("data-id");
        if (t === "global") openGlobal(true);
        if (t === "dm") openDM(id);
        if (t === "group") openGroup(id);
      });

      // Right click to mute placeholder (UI only unless you add server support)
      row.addEventListener("contextmenu", (e)=>{
        e.preventDefault();
        const t = row.getAttribute("data-open");
        const id = row.getAttribute("data-id");
        openModal("Mute", `
          <div style="color:var(--muted);font-size:12px;line-height:1.45">
            Muting is UI-only right now unless you add server-side mutes.
          </div>
          <div style="display:flex;gap:10px;margin-top:12px">
            <button class="btn primary" id="muteOk">OK</button>
          </div>
        `);
        const ok = $("muteOk");
        if (ok) ok.onclick = closeModal;
      });
    });
  }

  const createBtn = $("createGroupBtn");
  if (createBtn){
    createBtn.onclick = () => {
      if (isGuest){
        toast("Guests", "Guests can’t create groups. Log in to use groups.");
        return;
      }
      openModal("Create group", `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="font-size:12px;color:var(--muted)">Group name</div>
          <input id="gcName" class="field" placeholder="Unnamed Group" />
          <div style="font-size:12px;color:var(--muted)">Invite at least 1 user</div>
          <input id="gcInvites" class="field" placeholder="user1, user2, user3" />
          <button class="btn primary" id="gcCreate">Send invites</button>
          <div style="font-size:11px;color:var(--muted);line-height:1.45">
            A group becomes active only after someone accepts your invite.
          </div>
        </div>
      `);
      setTimeout(()=> $("gcName")?.focus(), 40);

      const go = $("gcCreate");
      if (go){
        go.onclick = () => {
          const name = ($("gcName")?.value || "").trim();
          const rawInv = ($("gcInvites")?.value || "").trim();
          const invites = rawInv
            .split(",")
            .map(s => s.trim())
            .filter(Boolean);

          closeModal();

          // New flow (invites-required)
          socket.emit("group:createRequest", { name, invites });

          // Backward compatibility: if server still uses old event
          socket.emit("group:create", { name });

          toast("Group", "Sending invites…");
        };
      }
    };
  }
}

function renderSidebarInbox(){
  if (!sideSection) return;

  if (isGuest){
    sideSection.innerHTML = `
      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px;line-height:1.45">
        Guest mode has no inbox.
        <br><br>
        Log in to get friend requests, invites, and mentions.
      </div>
    `;
    return;
  }

  // Fetch latest
  socket.emit("inbox:get");

  const friends = Array.isArray(social?.incoming) ? social.incoming : [];
  const invites = Array.isArray(window.__groupInvitesCache) ? window.__groupInvitesCache : [];
  const localMentions = mentions;

  const items = [];

  for (const m of localMentions){
    items.push({
      type: "mention",
      label: `${m.from} mentioned you in ${m.scope}`,
      sub: new Date(m.ts).toLocaleString(),
      action: "viewMention",
      payload: m
    });
  }

  for (const u of friends){
    items.push({
      type: "friend",
      label: `${u} sent a friend request`,
      sub: "Tap to accept",
      action: "acceptFriend",
      payload: u
    });
  }

  for (const inv of invites){
    items.push({
      type: "invite",
      label: `${inv.from} invited you to “${inv.name}”`,
      sub: "Tap to accept",
      action: "acceptInvite",
      payload: inv
    });
  }

  sideSection.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
      <div style="font-weight:950;font-size:12px;color:#dbe6f1">Inbox</div>
      <div style="font-size:11px;color:var(--muted)">${items.length} item(s)</div>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px" id="inboxList">
      ${items.length ? items.map((it, idx)=>`
        <div class="row" data-inbox-idx="${idx}">
          <div class="rowLeft">
            <div class="statusDot on"></div>
            <div class="nameCol">
              <div class="rowName">${escapeHtml(it.label)}</div>
              <div class="rowSub">${escapeHtml(it.sub)}</div>
            </div>
          </div>
          <button class="btn small primary" data-inbox-action="${escapeHtml(it.action)}" data-inbox-idx="${idx}">Open</button>
        </div>
      `).join("") : `
        <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02);color:var(--muted);font-size:12px">
          Nothing here right now.
        </div>
      `}
    </div>
  `;

  const list = $("inboxList");
  if (!list) return;

  list.querySelectorAll("[data-inbox-action]").forEach(btn=>{
    btn.addEventListener("click", (e)=>{
      e.stopPropagation();
      const idx = Number(btn.getAttribute("data-inbox-idx"));
      const action = btn.getAttribute("data-inbox-action");
      const it = items[idx];
      if (!it) return;

      if (action === "viewMention"){
        // Jump to global + optionally show context
        openGlobal(true);
        // Clear all mentions after viewing
        mentions = [];
        updateBadges();
        toast("Mention", "Opened global chat.");
        return;
      }

      if (action === "acceptFriend"){
        socket.emit("friend:accept", { from: it.payload });
        toast("Friends", `Accepted ${it.payload}.`);
        // Remove from local state quickly
        if (social?.incoming) social.incoming = social.incoming.filter(x => x !== it.payload);
        updateBadges();
        renderSidebarInbox();
        return;
      }

      if (action === "acceptInvite"){
        socket.emit("groupInvite:accept", { id: it.payload.id });
        toast("Group", "Invite accepted.");
        // Remove locally
        window.__groupInvitesCache = invites.filter(x => x.id !== it.payload.id);
        updateBadges();
        renderSidebarInbox();
        return;
      }
    });
  });

  updateBadges();
}

// ------------------------- Openers -------------------------
function openGlobal(force){
  currentDM = null;
  currentGroupId = null;
  setView("global");

  if (tabGlobal) tabGlobal.classList.add("primary");
  if (tabMessages) tabMessages.classList.remove("primary");
  if (tabInbox) tabInbox.classList.remove("primary");

  if (force){
    clearChat();
    globalCache.forEach(m => addMessageToUI(m, { scope:"global" }));
  }
  socket.emit("requestGlobalHistory");
  renderSidebarGlobal();
}

function openDM(user){
  if (isGuest){
    toast("Guests", "Guests can’t DM. Log in to use DMs.");
    return;
  }
  if (!user) return;
  currentDM = user;
  currentGroupId = null;
  setView("dm", user);

  if (tabGlobal) tabGlobal.classList.remove("primary");
  if (tabMessages) tabMessages.classList.add("primary");
  if (tabInbox) tabInbox.classList.remove("primary");

  // Clear unread for this DM
  unreadDM.set(user, 0);
  updateBadges();

  clearChat();
  socket.emit("dm:history", { withUser: user });
  renderSidebarMessages();
}

function openGroup(gid){
  if (isGuest) return;
  if (!gid) return;
  currentGroupId = gid;
  currentDM = null;
  setView("group", gid);

  if (tabGlobal) tabGlobal.classList.remove("primary");
  if (tabMessages) tabMessages.classList.add("primary");
  if (tabInbox) tabInbox.classList.remove("primary");

  // Clear unread for this group
  unreadGroup.set(gid, 0);
  updateBadges();

  clearChat();
  socket.emit("group:history", { groupId: gid });
  renderSidebarMessages();
}

// ------------------------- Group management modal -------------------------
function openGroupManage(gid){
  const meta = groupMeta.get(gid);
  if (!meta) return;

  const isOwner = meta.owner === me;

  const membersHtml = (meta.members || []).map(u => `
    <div class="row" data-member="${escapeHtml(u)}" title="${u===me ? "Right-click your name to leave" : ""}">
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
        <div style="min-width:0">
          <div style="font-weight:950;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(meta.name)}</div>
          <div style="font-size:12px;color:var(--muted)">${escapeHtml(meta.id)}</div>
        </div>
        <button class="btn small" id="closeG">Close</button>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Members</div>
        <div style="display:flex;flex-direction:column;gap:8px" id="membersList">${membersHtml}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:10px">
          Tip: Right-click your own name to leave.
        </div>
      </div>

      ${isOwner ? `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="font-weight:900;font-size:12px">Owner controls</div>

          <div style="display:flex;gap:10px">
            <input id="renameGroup" class="field" placeholder="Rename group…" />
            <button class="btn small" id="renameBtn">Rename</button>
          </div>

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

  const closeG = $("closeG");
  if (closeG) closeG.onclick = closeModal;

  // Remove member (owner)
  if (modalBody){
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
        if (u !== me) return;

        openModal("Leave group?", `
          <div style="color:var(--muted);font-size:12px;line-height:1.45">
            Leave <b>${escapeHtml(meta.name)}</b>? You can be re-added by the owner.
          </div>
          <div style="display:flex;gap:10px;margin-top:12px">
            <button class="btn" id="cancelLeave">Cancel</button>
            <button class="btn primary" id="confirmLeave">Leave</button>
          </div>
        `);
        const c = $("cancelLeave");
        const y = $("confirmLeave");
        if (c) c.onclick = ()=> openGroupManage(gid);
        if (y) y.onclick = ()=>{
          closeModal();
          socket.emit("group:leave", { groupId: gid });
          toast("Group", "Leaving…");
        };
      });
    });
  }

  if (isOwner){
    const addBtn = $("addBtn");
    const transferBtn = $("transferBtn");
    const deleteBtn = $("deleteBtn");
    const renameBtn = $("renameBtn");

    if (addBtn) addBtn.onclick = ()=>{
      const u = ($("addUser")?.value || "").trim();
      if (!u) return;
      socket.emit("group:addMember", { groupId: gid, user: u });
      toast("Group", `Adding ${u}…`);
    };

    if (transferBtn) transferBtn.onclick = ()=>{
      const u = ($("transferUser")?.value || "").trim();
      if (!u) return;
      socket.emit("group:transferOwner", { groupId: gid, newOwner: u });
      toast("Group", `Transferring to ${u}…`);
    };

    if (renameBtn) renameBtn.onclick = ()=>{
      const n = ($("renameGroup")?.value || "").trim();
      if (!n) return;
      socket.emit("group:rename", { groupId: gid, name: n });
      toast("Group", "Renaming…");
    };

    if (deleteBtn) deleteBtn.onclick = ()=>{
      openModal("Delete group?", `
        <div style="color:var(--muted);font-size:12px;line-height:1.45">
          Delete <b>${escapeHtml(meta.name)}</b>? This can’t be undone.
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn" id="cancelDel">Cancel</button>
          <button class="btn primary" id="confirmDel">Delete</button>
        </div>
      `);
      const c = $("cancelDel");
      const y = $("confirmDel");
      if (c) c.onclick = ()=> openGroupManage(gid);
      if (y) y.onclick = ()=>{
        closeModal();
        socket.emit("group:delete", { groupId: gid });
        toast("Group", "Deleting…");
      };
    };
  } else {
    const leaveBtn = $("leaveBtn");
    if (leaveBtn) leaveBtn.onclick = ()=>{
      socket.emit("group:leave", { groupId: gid });
      closeModal();
      toast("Group", "Leaving…");
    };
  }
}

// ------------------------- Profile modal -------------------------
function openProfile(user){
  if (!user) return;

  // Guest profile: name only
  const guest = isGuestUser(user);
  openModal("Profile", `
    <div style="display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
        <div style="min-width:0">
          <div style="font-weight:950;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(user)}</div>
          <div style="font-size:12px;color:var(--muted)" id="profSub">${guest ? "Guest user" : "loading…"}</div>
        </div>
        <button class="btn small" id="profClose">Close</button>
      </div>

      ${guest ? "" : `
      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Stats</div>
        <div id="profStats" style="display:flex;flex-direction:column;gap:6px;color:var(--muted);font-size:12px">
          loading…
        </div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        ${(user !== me && !isGuest) ? `<button class="btn" id="dmBtn">DM</button>` : ``}
        ${(user !== me && !isGuest) ? `<button class="btn" id="friendBtn">Add friend</button>` : ``}
        ${(user !== me && !isGuest) ? `<button class="btn" id="blockBtn">Block</button>` : ``}
      </div>
      `}
    </div>
  `);

  const pc = $("profClose");
  if (pc) pc.onclick = closeModal;

  if (!guest){
    socket.emit("profile:get", { user });
    if (modalBody) modalBody._profileUser = user;
  }

  // Bind actions immediately (they’ll work once profile:data arrives)
  setTimeout(()=>{
    const dmBtn = $("dmBtn");
    const friendBtn = $("friendBtn");
    const blockBtn = $("blockBtn");

    if (dmBtn) dmBtn.onclick = ()=>{
      closeModal();
      openDM(user);
    };
    if (friendBtn) friendBtn.onclick = ()=>{
      socket.emit("friend:request", { to: user });
      toast("Friends", "Request sent.");
    };
    if (blockBtn) blockBtn.onclick = ()=>{
      socket.emit("user:block", { user });
      toast("Blocked", `${user} blocked.`);
      closeModal();
    };
  }, 0);
}

// ------------------------- Settings modal (IMPORTANT: preview only, save to apply permanently) -------------------------
function openSettings(){
  if (isGuest){
    openModal("Settings (Guest)", `
      <div style="color:var(--muted);font-size:12px;line-height:1.45">
        Guest settings aren’t saved. Log in to save theme/layout.
      </div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn primary" id="closeS">Close</button>
      </div>
    `);
    const c = $("closeS");
    if (c) c.onclick = closeModal;
    return;
  }

  const current = settings || {};
  const originalTheme = current.theme || "dark";
  const originalDensity = Number.isFinite(current.density) ? current.density : 0.55;

  // Draft copy for preview changes (does not mutate `settings`)
  const draft = {
    theme: originalTheme,
    density: originalDensity,
    hideMildProfanity: !!current.hideMildProfanity
  };

  const themeKeys = ["dark","vortex","abyss","carbon"];
  const themeIndex = Math.max(0, themeKeys.indexOf(draft.theme));

  openModal("Settings", `
    <div style="display:flex;flex-direction:column;gap:10px">

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Theme</div>
        <input id="themeSlider" type="range" min="0" max="${themeKeys.length-1}" step="1" value="${themeIndex}" style="width:100%">
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Current: <b id="themeName">${escapeHtml(draft.theme)}</b></div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="font-weight:900;font-size:12px;margin-bottom:8px">Layout density</div>
        <input id="densitySlider" type="range" min="0" max="1" step="0.01" value="${draft.density}" style="width:100%">
        <div style="font-size:12px;color:var(--muted);margin-top:6px">Compact ↔ Cozy</div>
      </div>

      <div style="padding:12px;border:1px solid var(--stroke);border-radius:14px;background:rgba(255,255,255,.02)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
          <div style="min-width:180px">
            <div style="font-weight:900;font-size:12px">Hide mild profanity</div>
            <div style="font-size:11px;color:var(--muted)">F/S/A words etc masked as •••.</div>
          </div>
          <button class="btn small" id="toggleMild">${draft.hideMildProfanity ? "On" : "Off"}</button>
        </div>
      </div>

      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn primary" id="saveS">Save</button>
        <button class="btn" id="closeS">Close</button>
      </div>
    </div>
  `);

  const themeSlider = $("themeSlider");
  const densitySlider = $("densitySlider");
  const themeName = $("themeName");

  if (themeSlider){
    themeSlider.addEventListener("input", ()=>{
      const k = themeKeys[Number(themeSlider.value)];
      draft.theme = k;
      if (themeName) themeName.textContent = k;
      applyTheme(k); // preview only
    });
  }

  if (densitySlider){
    densitySlider.addEventListener("input", ()=>{
      draft.density = Number(densitySlider.value);
      applyDensity(draft.density); // preview only
    });
  }

  const toggleMild = $("toggleMild");
  if (toggleMild){
    toggleMild.onclick = ()=>{
      draft.hideMildProfanity = !draft.hideMildProfanity;
      toggleMild.textContent = draft.hideMildProfanity ? "On" : "Off";
    };
  }

  const closeS = $("closeS");
  if (closeS){
    closeS.onclick = ()=>{
      // revert preview changes if not saved
      applyTheme(originalTheme);
      applyDensity(originalDensity);
      closeModal();
    };
  }

  const saveS = $("saveS");
  if (saveS){
    saveS.onclick = ()=>{
      settings = settings || {};
      settings.theme = draft.theme;
      settings.density = draft.density;
      settings.hideMildProfanity = draft.hideMildProfanity;

      socket.emit("settings:update", settings);
      toast("Settings", "Saved.");
      closeModal();
    };
  }
}

// ------------------------- Tabs -------------------------
if (tabGlobal) tabGlobal.addEventListener("click", ()=> openGlobal(true));
if (tabMessages) tabMessages.addEventListener("click", ()=>{
  if (tabGlobal) tabGlobal.classList.remove("primary");
  if (tabMessages) tabMessages.classList.add("primary");
  if (tabInbox) tabInbox.classList.remove("primary");
  renderSidebarMessages();
});
if (tabInbox) tabInbox.addEventListener("click", ()=>{
  if (tabGlobal) tabGlobal.classList.remove("primary");
  if (tabMessages) tabMessages.classList.remove("primary");
  if (tabInbox) tabInbox.classList.add("primary");
  renderSidebarInbox();
});

// ------------------------- Composer -------------------------
function sendCurrent(){
  if (!me) return;

  if (!canSend()){
    cooldownWarn();
    return;
  }

  const text = (messageEl?.value || "").trim();
  if (!text) return;

  startCooldown();
  if (messageEl) messageEl.value = "";

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
  messageEl.addEventListener("keydown", (e)=>{
    if (e.key === "Enter" && !e.shiftKey){
      e.preventDefault();
      sendCurrent();
    }
  });
}

// ------------------------- Auth buttons -------------------------
if (settingsBtn) settingsBtn.addEventListener("click", openSettings);

if (logoutBtn){
  logoutBtn.addEventListener("click", ()=>{
    showLoading("logging out…");
    setTimeout(()=>{
      localStorage.removeItem("tonkotsu_token");
      location.reload();
    }, 450);
  });
}

if (loginBtn){
  loginBtn.addEventListener("click", ()=>{
    if (loginOverlay) loginOverlay.classList.remove("hidden");
  });
}

// Shake login
function shakeLogin(){
  const card = document.querySelector(".loginCard");
  if (!card) return;
  card.classList.add("shake");
  setTimeout(()=> card.classList.remove("shake"), 380);
}

// Join
if (joinBtn){
  joinBtn.addEventListener("click", ()=>{
    const u = (usernameEl?.value || "").trim();
    const p = (passwordEl?.value || "");

    if (!u || !p){
      shakeLogin();
      return;
    }

    showLoading("logging in…");
    socket.emit("login", { username: u, password: p, guest:false });
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

// ------------------------- Session restore on refresh -------------------------
function tryResume(){
  if (token){
    socket.emit("resume", { token });
    showLoading("resuming session…");
  }
}
tryResume();

// ------------------------- Socket events -------------------------
socket.on("resumeFail", ()=>{
  localStorage.removeItem("tonkotsu_token");
  token = null;
  hideLoading();
});

socket.on("loginSuccess",(data)=>{
  hideLoading();

  me = data.username;
  isGuest = !!data.guest;

  settings = data.settings || settings || { theme:"dark", density:0.55, hideMildProfanity:false };
  social = data.social || social || { friends:[], incoming:[], outgoing:[], blocked:[] };
  xp = data.xp ?? null;

  // Apply immediately (server-controlled defaults)
  applyTheme(settings?.theme || "dark");
  applyDensity(settings?.density ?? 0.55);

  // show app
  if (loginOverlay) loginOverlay.classList.add("hidden");
  if (app) app.classList.add("show");

  if (mePill) mePill.style.display = "flex";
  if (meName) meName.textContent = me;

  // token store
  if (!isGuest && data.token){
    localStorage.setItem("tonkotsu_token", data.token);
    token = data.token;
  }

  // guest limitations toggles
  if (isGuest){
    if (settingsBtn) settingsBtn.style.display="none";
    if (logoutBtn) logoutBtn.style.display="none";
    if (loginBtn) loginBtn.style.display="inline-flex";
  } else {
    if (settingsBtn) settingsBtn.style.display="inline-flex";
    if (logoutBtn) logoutBtn.style.display="inline-flex";
    if (loginBtn) loginBtn.style.display="none";
  }

  updateBadges();
  toast("Welcome", isGuest ? "Joined as Guest" : `Logged in as ${me}`);

  // kick off state pulls
  openGlobal(true);
  if (!isGuest){
    socket.emit("groups:list");
    socket.emit("social:sync");
    socket.emit("inbox:get");
  }
});

socket.on("loginError",(msg)=>{
  hideLoading();
  shakeLogin();
  toast("Login failed", msg || "Try again.");
});

socket.on("settings",(s)=>{
  settings = s || settings;
  applyTheme(settings?.theme || "dark");
  applyDensity(settings?.density ?? 0.55);
});

socket.on("social:update",(s)=>{
  social = s || social;
  updateBadges();
  if (tabInbox?.classList.contains("primary")) renderSidebarInbox();
});

socket.on("inbox:update",(counts)=>{
  // counts: { friendRequests, groupInvites }
  // we’ll fetch full list via inbox:get anyway; this is for badge speed
  updateBadges();
});

socket.on("inbox:data",(data)=>{
  // { friendRequests:[...], groupInvites:[{id,from,name,ts}] }
  window.__groupInvitesCache = Array.isArray(data?.groupInvites) ? data.groupInvites : [];
  // friendRequests already mirrored in social.incoming; but keep safe
  if (social && Array.isArray(data?.friendRequests)) {
    social.incoming = data.friendRequests;
  }
  updateBadges();
  if (tabInbox?.classList.contains("primary")) renderSidebarInbox();
});

socket.on("xp:update",(x)=>{
  xp = x;
  // You can hook a UI bar here if your index.html has one.
});

socket.on("onlineUsers",(list)=>{
  onlineUsers = Array.isArray(list) ? list : [];
  if (view.type === "global") renderSidebarGlobal();
  if (tabMessages?.classList.contains("primary")) renderSidebarMessages();
});

socket.on("history",(msgs)=>{
  globalCache = (Array.isArray(msgs)?msgs:[])
    .filter(m => Number.isFinite(new Date(m.ts).getTime()));
  if (view.type === "global"){
    clearChat();
    globalCache.forEach(m=> addMessageToUI(m, { scope:"global" }));
  }
});

socket.on("globalMessage",(m)=>{
  if (!m || !Number.isFinite(new Date(m.ts).getTime())) return;
  globalCache.push(m);
  if (globalCache.length > 250) globalCache.shift();
  if (view.type === "global") addMessageToUI(m, { scope:"global" });
});

socket.on("sendError",(e)=>{
  toast("Action blocked", e?.reason || "Blocked.");
});

// DM history + message
socket.on("dm:history", ({ withUser, msgs } = {})=>{
  const other = withUser;
  const list = Array.isArray(msgs) ? msgs : [];
  dmCache.set(other, list);

  if (view.type === "dm" && currentDM === other){
    clearChat();
    list.forEach(m => addMessageToUI(m, { scope:"dm", from: other }));
  }
});

socket.on("dm:message", ({ from, msg } = {})=>{
  if (!from || !msg) return;
  if (!dmCache.has(from)) dmCache.set(from, []);
  dmCache.get(from).push(msg);
  if (dmCache.get(from).length > 250) dmCache.get(from).shift();

  // unread
  if (!(view.type === "dm" && currentDM === from)){
    unreadDM.set(from, (unreadDM.get(from)||0) + 1);
    updateBadges();
  }

  if (view.type === "dm" && currentDM === from){
    addMessageToUI(msg, { scope:"dm", from });
  }

  if (tabMessages?.classList.contains("primary")) renderSidebarMessages();
});

// Groups list
socket.on("groups:list",(list)=>{
  if (isGuest) return;

  groupMeta.clear();
  (Array.isArray(list)?list:[]).forEach(g=>{
    groupMeta.set(g.id, { id:g.id, name:g.name, owner:g.owner, members:Array.isArray(g.members)?g.members:[] });
  });

  if (tabMessages?.classList.contains("primary")) renderSidebarMessages();
});

// Group request created (invites-required flow)
socket.on("group:requestCreated",(g)=>{
  if (!g) return;
  toast("Group", `Invites sent for “${g.name}”`);
});

// Group history
socket.on("group:history",({ groupId, meta, msgs })=>{
  if (!groupId || !meta) return;

  groupMeta.set(groupId, meta);
  groupCache.set(groupId, Array.isArray(msgs)?msgs:[]);
  currentGroupId = groupId;

  setView("group", groupId);

  clearChat();
  (msgs || []).forEach(m=> addMessageToUI(m, { scope:"group", groupId }));

  // Provide a manage link in hint
  if (chatHint){
    chatHint.innerHTML = `members: <b style="color:var(--text)">${meta.members.length}</b> • <span style="text-decoration:underline;cursor:pointer" id="manageGroupLink">manage</span>`;
    setTimeout(()=>{
      const link = document.getElementById("manageGroupLink");
      if (link) link.onclick = ()=> openGroupManage(groupId);
    }, 0);
  }

  // clear unread
  unreadGroup.set(groupId, 0);
  updateBadges();
});

// Group message
socket.on("group:message",({ groupId, msg })=>{
  if (!groupId || !msg) return;

  if (!groupCache.has(groupId)) groupCache.set(groupId, []);
  groupCache.get(groupId).push(msg);
  if (groupCache.get(groupId).length > 350) groupCache.get(groupId).shift();

  const active = (view.type === "group" && currentGroupId === groupId);

  if (!active){
    unreadGroup.set(groupId, (unreadGroup.get(groupId)||0) + 1);
    updateBadges();
  } else {
    addMessageToUI(msg, { scope:"group", groupId });
  }

  if (tabMessages?.classList.contains("primary")) renderSidebarMessages();
});

// Group meta update
socket.on("group:meta",({ groupId, meta, name, owner, members })=>{
  // server may send either {groupId, meta:{...}} or legacy {groupId,name,owner,members}
  const incomingMeta = meta || { id: groupId, name, owner, members };
  if (!groupId || !incomingMeta) return;

  const m = groupMeta.get(groupId) || { id: groupId, name: incomingMeta.name || groupId, owner: incomingMeta.owner || "—", members: incomingMeta.members || [] };
  m.name = incomingMeta.name ?? m.name;
  m.owner = incomingMeta.owner ?? m.owner;
  if (Array.isArray(incomingMeta.members)) m.members = incomingMeta.members;
  groupMeta.set(groupId, m);

  if (view.type === "group" && currentGroupId === groupId && chatTitle){
    chatTitle.textContent = `Group — ${m.name}`;
  }
  if (tabMessages?.classList.contains("primary")) renderSidebarMessages();
});

// Group left/deleted
socket.on("group:left",({ groupId })=>{
  toast("Group", "You left the group.");
  unreadGroup.delete(groupId);
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  updateBadges();
  openGlobal(true);
  socket.emit("groups:list");
});
socket.on("group:deleted",({ groupId })=>{
  toast("Group", "Group deleted.");
  unreadGroup.delete(groupId);
  groupMeta.delete(groupId);
  groupCache.delete(groupId);
  updateBadges();
  openGlobal(true);
  socket.emit("groups:list");
});

// Profile data
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

  if (sub) sub.textContent = `Level ${level} • ${msgs} messages`;

  // Simple XP bar that won’t break layout
  const pct = xpNext > 0 ? Math.max(0, Math.min(1, xpNow / xpNext)) : 0;

  if (stats){
    stats.innerHTML = `
      <div><b style="color:var(--text)">Account created:</b> ${escapeHtml(created)}</div>
      <div><b style="color:var(--text)">Level:</b> ${level}</div>
      <div><b style="color:var(--text)">Messages:</b> ${msgs}</div>
      <div style="margin-top:8px">
        <div style="display:flex;justify-content:space-between;gap:10px">
          <div style="color:var(--muted)">XP</div>
          <div style="color:var(--muted)">${xpNow} / ${xpNext}</div>
        </div>
        <div style="margin-top:6px;height:10px;border-radius:999px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.10);overflow:hidden">
          <div style="height:100%;width:${Math.round(pct*100)}%;background:rgba(255,255,255,.18)"></div>
        </div>
      </div>
    `;
  }
});

// ------------------------- Boot UI defaults -------------------------
applyTheme("dark");
applyDensity(0.55);

// Default tab state: Global
if (tabGlobal) tabGlobal.classList.add("primary");
renderSidebarGlobal();

// If user opens app without logging in, keep login overlay visible
// If you later want click-outside-to-close for login overlay, add it here.
