/* script.js (Browser ONLY): UI, DOM, Socket.IO client */
/* global io */

'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

const state = {
  token: null,
  me: null,
  socket: null,

  threads: [], // {id,type,name,members,createdAt}
  activeThreadId: 'global',

  messages: new Map(), // threadId -> [msg]
  usersById: new Map(), // id -> public user
  online: [],

  // Unread/mentions counts
  lastReadAt: new Map(), // threadId -> ms
  unread: new Map(),     // threadId -> count
  mentions: new Map(),   // threadId -> count

  // Optimistic sends & retry
  pending: new Map(),    // clientId -> {threadId, content, createdAt, retries}
};

const UI = {
  meDot: $('#meDot'),
  meDot2: $('#meDot2'),
  meName: $('#meName'),
  meStatus: $('#meStatus'),
  btnProfile: $('#btnProfile'),
  btnAuth: $('#btnAuth'),
  btnNew: $('#btnNew'),
  btnLogout: $('#btnLogout'),
  btnAnnounce: $('#btnAnnounce'),

  threadsWrap: $('#threads'),

  threadDot: $('#threadDot'),
  threadTitle: $('#threadTitle'),
  threadSub: $('#threadSub'),

  messages: $('#messages'),
  composer: $('#composer'),
  sendBtn: $('#sendBtn'),

  cooldownBar: $('#cooldownBar'),
  cooldownFill: $('#cooldownFill'),

  onlineList: $('#onlineList'),
  onlineCount: $('#onlineCount'),

  backdrop: $('#backdrop'),
  modal: $('#modal'),
  modalTitle: $('#modalTitle'),
  modalBody: $('#modalBody'),
  modalFoot: $('#modalFoot'),
  modalClose: $('#modalClose'),

  ctx: $('#ctx'),
  toasts: $('#toasts'),
};

function toast(title, detail, ms = 2400) {
  const t = el('div', 'toast');
  const b = el('div');
  b.textContent = title;
  const s = el('small');
  s.textContent = detail || '';
  t.appendChild(b);
  if (detail) t.appendChild(s);
  UI.toasts.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

function fmtTime(ms) {
  const d = new Date(ms);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}

function presenceDotClass(p) {
  return ['online','idle','dnd','invisible'].includes(p) ? p : 'online';
}

function badgeClass(b) {
  if (b === 'GUEST') return 'miniBadge badgeGuest';
  if (b === 'BETA') return 'miniBadge badgeBeta';
  if (b === 'EARLY ACCESS') return 'miniBadge badgeEarly';
  if (b === 'ANNOUNCEMENT') return 'miniBadge badgeAnn';
  return 'miniBadge';
}

function saveSession(token, me) {
  localStorage.setItem('tonkotsu_token', token);
  localStorage.setItem('tonkotsu_me', JSON.stringify(me));
}

function loadSession() {
  const t = localStorage.getItem('tonkotsu_token');
  const m = localStorage.getItem('tonkotsu_me');
  if (t && m) {
    try {
      state.token = t;
      state.me = JSON.parse(m);
    } catch {}
  }
}

function clearSession() {
  localStorage.removeItem('tonkotsu_token');
  localStorage.removeItem('tonkotsu_me');
  state.token = null;
  state.me = null;
}

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  headers['Content-Type'] = 'application/json';
  if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function openModal(title, bodyNodes, footNodes) {
  UI.modalTitle.textContent = title;
  UI.modalBody.innerHTML = '';
  UI.modalFoot.innerHTML = '';
  (bodyNodes || []).forEach(n => UI.modalBody.appendChild(n));
  (footNodes || []).forEach(n => UI.modalFoot.appendChild(n));
  UI.backdrop.classList.add('show');
}

function closeModal() {
  UI.backdrop.classList.remove('show');
}

UI.modalClose.addEventListener('click', closeModal);
UI.backdrop.addEventListener('click', (e) => {
  if (e.target === UI.backdrop) closeModal();
});

function hideCtx() {
  UI.ctx.classList.remove('show');
  UI.ctx.innerHTML = '';
}
document.addEventListener('click', () => hideCtx());
document.addEventListener('contextmenu', (e) => {
  if (!e.target.closest('.msg')) hideCtx();
});

function showCtx(x, y, items) {
  UI.ctx.innerHTML = '';
  items.forEach(it => {
    const row = el('div', 'ctxItem' + (it.danger ? ' danger' : ''));
    row.textContent = it.label;
    row.addEventListener('click', () => {
      hideCtx();
      it.onClick();
    });
    UI.ctx.appendChild(row);
  });
  UI.ctx.style.left = x + 'px';
  UI.ctx.style.top = y + 'px';
  UI.ctx.classList.add('show');
}

// ---------- Auth & bootstrap ----------

async function ensureMe() {
  if (!state.token) return false;
  try {
    const data = await api('/api/me');
    state.me = data.user;
    saveSession(state.token, state.me);
    return true;
  } catch {
    clearSession();
    return false;
  }
}

function renderMe() {
  const me = state.me;
  if (!me) {
    UI.meName.textContent = 'Not logged in';
    UI.meStatus.textContent = 'Login or continue as guest';
    UI.btnLogout.style.display = 'none';
    UI.btnAnnounce.style.display = 'none';
    setDot(UI.meDot, 'invisible');
    setDot(UI.meDot2, 'invisible');
    return;
  }

  UI.meName.textContent = me.username;
  UI.meStatus.textContent = me.statusText || (me.isGuest ? 'Guest' : 'Online');

  UI.btnLogout.style.display = 'inline-flex';
  UI.btnAnnounce.style.display = me.badges && me.badges.includes('ANNOUNCEMENT') ? 'inline-flex' : 'none';
  setDot(UI.meDot, me.presence);
  setDot(UI.meDot2, me.presence);
}

function setDot(node, presence) {
  node.classList.remove('online','idle','dnd','invisible');
  node.classList.add(presenceDotClass(presence));
}

// ---------- Threads & unread ----------

function resetUnread(threadId) {
  state.unread.set(threadId, 0);
  state.mentions.set(threadId, 0);
  state.lastReadAt.set(threadId, Date.now());
  renderThreads();
}

function bumpUnread(threadId, isMention) {
  if (threadId === state.activeThreadId) return;
  state.unread.set(threadId, (state.unread.get(threadId) || 0) + 1);
  if (isMention) state.mentions.set(threadId, (state.mentions.get(threadId) || 0) + 1);
  renderThreads();
}

function threadPingCount(threadId) {
  const m = state.mentions.get(threadId) || 0;
  const u = state.unread.get(threadId) || 0;
  // Mentions dominate as red ping; show total (compact)
  return m > 0 ? m : u;
}

function renderThreads() {
  UI.threadsWrap.innerHTML = '';
  const threads = state.threads.slice().sort((a,b) => {
    // Global first, then groups, then dms, then alpha
    const rank = (t) => t.id === 'global' ? 0 : (t.type === 'group' ? 1 : 2);
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.name.localeCompare(b.name);
  });

  threads.forEach(t => {
    const row = el('div', 'thread' + (t.id === state.activeThreadId ? ' active' : ''));
    const dot = el('div', 'dot ' + presenceDotClass(threadDotPresence(t)));
    dot.style.width = '9px';
    dot.style.height = '9px';

    const name = el('div', 'threadName');
    name.textContent = t.id === 'global' ? '# global' : (t.type === 'group' ? '⛓ ' + t.name : '@ ' + t.name);

    const meta = el('div', 'threadMeta');
    const ping = el('div', 'ping');
    const count = threadPingCount(t.id);
    if (count > 0) {
      ping.textContent = String(Math.min(99, count));
      ping.classList.add('show');
    }
    meta.appendChild(ping);

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(meta);

    row.addEventListener('click', () => openThread(t.id));

    UI.threadsWrap.appendChild(row);
  });
}

function threadDotPresence(thread) {
  if (thread.id === 'global' || thread.type === 'group') return 'online';
  // DM: show other user's presence if known
  const other = state.threads.find(t => t.id === thread.id);
  const name = other ? other.name : '';
  const user = Array.from(state.usersById.values()).find(u => u.username === name);
  return user ? user.presence : 'online';
}

async function refreshThreads() {
  const data = await api('/api/threads');
  state.threads = data.threads || [];
  // Ensure global exists for UI
  if (!state.threads.find(t => t.id === 'global')) {
    state.threads.unshift({ id:'global', type:'global', name:'Global', members:[], createdAt: Date.now() });
  }
  // init unread maps
  for (const t of state.threads) {
    if (!state.lastReadAt.has(t.id)) state.lastReadAt.set(t.id, 0);
    if (!state.unread.has(t.id)) state.unread.set(t.id, 0);
    if (!state.mentions.has(t.id)) state.mentions.set(t.id, 0);
  }
  renderThreads();
}

// ---------- Messages ----------

function ensureThreadMessages(threadId) {
  if (!state.messages.has(threadId)) state.messages.set(threadId, []);
  return state.messages.get(threadId);
}

function isMentionToMe(content) {
  const me = state.me;
  if (!me) return false;
  const uname = me.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\s)@${uname}(\\b|\\s)`, 'i');
  return re.test(content);
}

function renderMessages(threadId) {
  const list = ensureThreadMessages(threadId);
  UI.messages.innerHTML = '';

  list.forEach(m => {
    const msg = el('div', 'msg');
    msg.dataset.id = m.id;

    if (m.type === 'announcement') msg.classList.add('announcement');

    const mention = isMentionToMe(m.content || '');
    if (mention) msg.classList.add('mention');

    const col = el('div', 'msgCol');
    const hdr = el('div', 'msgHdr');

    const name = el('div', 'msgName');
    name.textContent = m.senderName || 'Unknown';
    name.title = 'View profile';
    name.addEventListener('click', () => openProfileByName(m.senderName));

    const time = el('div', 'msgTime');
    time.textContent = fmtTime(m.createdAt);

    hdr.appendChild(name);
    hdr.appendChild(time);

    const body = el('div', 'msgBody');
    if (m.deletedAt) {
      body.innerHTML = `<span style="color:var(--muted)">(deleted)</span>`;
    } else {
      body.innerHTML = escapeHtml(m.content || '');
    }

    col.appendChild(hdr);
    col.appendChild(body);

    if (m.editedAt) {
      const note = el('div', 'msgNote');
      note.textContent = '(edited)';
      col.appendChild(note);
    }

    msg.appendChild(col);

    // Context menu for my messages
    msg.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      hideCtx();
      if (!state.me) return;
      if (m.senderId !== state.me.id) return;
      if (m.deletedAt) return;

      const canEdit = Date.now() - m.createdAt <= 60 * 1000;
      const items = [];
      if (canEdit) items.push({ label: 'Edit', onClick: () => openEditMessage(m) });
      if (canEdit) items.push({ label: 'Delete', danger: true, onClick: () => deleteMessage(m) });
      if (!items.length) return;
      showCtx(e.clientX, e.clientY, items);
    });

    UI.messages.appendChild(msg);
  });

  UI.messages.scrollTop = UI.messages.scrollHeight;
}

async function loadMessages(threadId) {
  const data = await api('/api/messages?threadId=' + encodeURIComponent(threadId) + '&limit=120');
  const msgs = data.messages || [];
  state.messages.set(threadId, msgs);
  renderMessages(threadId);
}

// ---------- Thread switching ----------

async function openThread(threadId) {
  state.activeThreadId = threadId;

  const t = state.threads.find(x => x.id === threadId) || { id: threadId, name: 'Chat', type: 'global' };
  UI.threadTitle.textContent = t.id === 'global' ? '# global' : t.name;
  UI.threadSub.textContent = t.type === 'group' ? 'Group chat' : (t.type === 'dm' ? 'Direct message' : 'Global chat');

  setDot(UI.threadDot, threadDotPresence(t));

  // Join room
  if (state.socket) {
    state.socket.emit('thread:join', { threadId }, (ack) => {
      if (!ack || !ack.ok) toast('Could not join', ack?.error || 'error');
    });
  }

  await loadMessages(threadId);
  resetUnread(threadId);
  renderThreads();
}

// ---------- Sending & cooldown bar ----------

function autoGrowTextarea() {
  UI.composer.style.height = 'auto';
  UI.composer.style.height = Math.min(140, UI.composer.scrollHeight) + 'px';
}
UI.composer.addEventListener('input', autoGrowTextarea);

function startCooldownBar(ms) {
  UI.cooldownBar.classList.add('show');
  const start = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - start) / ms);
    UI.cooldownFill.style.width = `${Math.floor(100 * t)}%`;
    if (t < 1) requestAnimationFrame(tick);
    else {
      UI.cooldownBar.classList.remove('show');
      UI.cooldownFill.style.width = '0%';
    }
  }
  requestAnimationFrame(tick);
}

function newClientId() {
  return 'c_' + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function pushOptimistic(threadId, content, clientId) {
  const list = ensureThreadMessages(threadId);
  const tmp = {
    id: 'pending:' + clientId,
    threadId,
    senderId: state.me.id,
    senderName: state.me.username,
    content,
    createdAt: Date.now(),
    editedAt: null,
    deletedAt: null,
    type: 'message',
    _pending: true,
    clientId,
  };
  list.push(tmp);
  renderMessages(threadId);
}

function replacePending(clientId, realMsg) {
  for (const [tid, arr] of state.messages.entries()) {
    const idx = arr.findIndex(m => m.id === 'pending:' + clientId);
    if (idx !== -1) {
      arr[idx] = realMsg;
      if (tid === state.activeThreadId) renderMessages(tid);
      return;
    }
  }
}

function markPendingFailed(clientId, reason) {
  for (const [tid, arr] of state.messages.entries()) {
    const msg = arr.find(m => m.id === 'pending:' + clientId);
    if (msg) {
      msg.content = msg.content + `\n\n[FAILED: ${reason} — click to retry]`;
      msg._failed = true;
      if (tid === state.activeThreadId) renderMessages(tid);

      // click to retry
      const node = UI.messages.querySelector(`[data-id="pending:${clientId}"]`);
      if (node) {
        node.addEventListener('click', () => retrySend(clientId), { once: true });
      }
      return;
    }
  }
}

function sendMessage() {
  const me = state.me;
  if (!me) return toast('Not logged in', 'Login or guest first');
  const content = UI.composer.value.trim();
  if (!content) return;

  const threadId = state.activeThreadId;

  // Client-side guest DM/group restriction
  if (me.isGuest && threadId !== 'global') {
    toast('Guests cannot DM', 'Use a registered account');
    return;
  }

  UI.composer.value = '';
  autoGrowTextarea();

  const clientId = newClientId();
  state.pending.set(clientId, { threadId, content, createdAt: Date.now(), retries: 0 });
  pushOptimistic(threadId, content, clientId);

  state.socket.emit('message:send', { threadId, content, clientId }, (ack) => {
    if (!ack || !ack.ok) {
      const err = ack?.error || 'send failed';
      if (err.startsWith('Cooldown:')) {
        const ms = parseInt(err.split(':')[1] || '0', 10);
        startCooldownBar(ms);
        markPendingFailed(clientId, `cooldown ${Math.ceil(ms/1000)}s`);
      } else {
        markPendingFailed(clientId, err);
      }
      return;
    }
    // If server returned message, replace; otherwise server broadcast will add it anyway.
    if (ack.message) replacePending(clientId, ack.message);
    state.pending.delete(clientId);
  });
}

UI.sendBtn.addEventListener('click', sendMessage);
UI.composer.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function retrySend(clientId) {
  const p = state.pending.get(clientId);
  if (!p) return;
  if (p.retries >= 3) return toast('Retry limit', 'Please resend manually');
  p.retries++;

  // restore original content by removing FAILED note
  const content = p.content;
  state.socket.emit('message:send', { threadId: p.threadId, content, clientId }, (ack) => {
    if (!ack || !ack.ok) {
      markPendingFailed(clientId, ack?.error || 'send failed');
      return;
    }
    if (ack.message) replacePending(clientId, ack.message);
    state.pending.delete(clientId);
  });
}

// ---------- Socket events ----------

function attachSocket() {
  if (!state.token) return;
  state.socket = io({
    auth: { token: state.token }
  });

  state.socket.on('connect', () => {
    // join active thread
    state.socket.emit('thread:join', { threadId: state.activeThreadId }, () => {});
  });

  state.socket.on('message:new', ({ message }) => {
    if (!message) return;

    // Dedup against optimistic pending by clientId not available (server doesn't echo clientId in msg)
    // We'll dedupe by content + close timestamp only for pending replacement fallback.
    const arr = ensureThreadMessages(message.threadId);

    // Hard dedupe by message.id
    if (arr.some(m => m.id === message.id)) return;

    arr.push(message);
    // Keep last 400 per thread
    if (arr.length > 400) arr.splice(0, arr.length - 400);

    const mention = isMentionToMe(message.content || '');
    bumpUnread(message.threadId, mention);

    // If active thread, render immediately and mark read
    if (message.threadId === state.activeThreadId) {
      renderMessages(state.activeThreadId);
      resetUnread(state.activeThreadId);
    }
  });

  state.socket.on('message:edit', ({ messageId, content, editedAt }) => {
    for (const [tid, arr] of state.messages.entries()) {
      const m = arr.find(x => x.id === messageId);
      if (m) {
        m.content = content;
        m.editedAt = editedAt;
        if (tid === state.activeThreadId) renderMessages(tid);
        return;
      }
    }
  });

  state.socket.on('message:delete', ({ messageId, deletedAt }) => {
    for (const [tid, arr] of state.messages.entries()) {
      const m = arr.find(x => x.id === messageId);
      if (m) {
        m.deletedAt = deletedAt;
        if (tid === state.activeThreadId) renderMessages(tid);
        return;
      }
    }
  });

  state.socket.on('presence:list', ({ users }) => {
    state.online = Array.isArray(users) ? users.map(x => x.user) : [];
    for (const u of state.online) state.usersById.set(u.id, u);
    renderOnline();
    renderThreads();
  });

  state.socket.on('presence:update', ({ user }) => {
    if (!user) return;
    state.usersById.set(user.id, user);
    if (state.me && user.id === state.me.id) {
      state.me = user;
      saveSession(state.token, state.me);
      renderMe();
    }
    renderOnline();
    renderThreads();
  });

  state.socket.on('connect_error', (err) => {
    toast('Socket error', err?.message || 'connect error');
  });
}

// ---------- Online panel ----------

function renderOnline() {
  UI.onlineList.innerHTML = '';
  const list = Array.from(state.usersById.values())
    .filter(u => state.online.some(o => o.id === u.id))
    .sort((a,b) => {
      const rank = { online:0, idle:1, dnd:2, invisible:3 };
      const ra = rank[a.presence] ?? 9;
      const rb = rank[b.presence] ?? 9;
      if (ra !== rb) return ra - rb;
      return a.username.localeCompare(b.username);
    });

  UI.onlineCount.textContent = String(list.length);

  list.forEach(u => {
    const row = el('div', 'userRow');
    const dot = el('div', 'dot ' + presenceDotClass(u.presence));
    const meta = el('div', 'userMeta');

    const name = el('div', 'userName');
    const nm = el('span');
    nm.textContent = u.username;
    name.appendChild(nm);

    const badgeRow = el('div', 'badgeRow');
    (u.badges || []).forEach(b => {
      const bd = el('span', badgeClass(b));
      bd.textContent = b;
      badgeRow.appendChild(bd);
    });

    const status = el('div', 'userStatus');
    status.textContent = u.statusText || (u.isGuest ? 'Guest' : '');

    meta.appendChild(name);
    meta.appendChild(status);
    meta.appendChild(badgeRow);

    row.appendChild(dot);
    row.appendChild(meta);

    row.addEventListener('click', () => openProfile(u));
    UI.onlineList.appendChild(row);
  });
}

// ---------- Profile modal ----------

function openProfileByName(username) {
  const u = Array.from(state.usersById.values()).find(x => x.username === username);
  if (u) return openProfile(u);
  toast('Profile', 'User not in online list yet');
}

function openProfile(user) {
  const isSelf = state.me && user.id === state.me.id;

  const header = el('div');
  header.style.display = 'flex';
  header.style.gap = '10px';
  header.style.alignItems = 'center';

  const dot = el('div', 'dot ' + presenceDotClass(user.presence));
  dot.style.width = '12px';
  dot.style.height = '12px';

  const title = el('div');
  title.style.minWidth = '0';
  const nm = el('div');
  nm.style.fontWeight = '900';
  nm.textContent = user.username;
  const st = el('div');
  st.style.color = 'var(--muted)';
  st.style.fontSize = '12px';
  st.textContent = user.statusText || (user.isGuest ? 'Guest' : '');
  title.appendChild(nm);
  title.appendChild(st);

  header.appendChild(dot);
  header.appendChild(title);

  const badges = el('div', 'badgeRow');
  (user.badges || []).forEach(b => {
    const bd = el('span', badgeClass(b));
    bd.textContent = b;
    badges.appendChild(bd);
  });

  const bio = el('div');
  bio.style.whiteSpace = 'pre-wrap';
  bio.style.color = user.bio ? 'var(--text)' : 'var(--muted)';
  bio.textContent = user.bio || 'No bio yet.';

  const nodes = [header, badges, bio];

  const foot = [];
  if (isSelf) {
    const edit = el('button', 'btn btnPrimary');
    edit.textContent = 'Edit Profile';
    edit.addEventListener('click', () => openEditProfile());
    foot.push(edit);

    const pres = el('button', 'btn');
    pres.textContent = 'Set Presence';
    pres.addEventListener('click', () => openPresenceModal());
    foot.push(pres);
  } else {
    if (state.me && !state.me.isGuest && !user.isGuest) {
      const dm = el('button', 'btn btnPrimary');
      dm.textContent = 'DM';
      dm.addEventListener('click', () => createDM(user.username));
      foot.push(dm);
    }
  }

  const close = el('button', 'btn');
  close.textContent = 'Close';
  close.addEventListener('click', closeModal);
  foot.push(close);

  openModal('Profile', nodes, foot);
}

function openEditProfile() {
  const me = state.me;
  if (!me) return;

  const r1 = el('div', 'row');
  const l1 = el('label'); l1.textContent = 'Status';
  const i1 = el('input'); i1.value = me.statusText || ''; i1.maxLength = 64;
  r1.appendChild(l1); r1.appendChild(i1);

  const r2 = el('div', 'row');
  const l2 = el('label'); l2.textContent = 'Bio';
  const t2 = el('textarea'); t2.value = me.bio || ''; t2.maxLength = 240;
  r2.appendChild(l2); r2.appendChild(t2);

  const save = el('button', 'btn btnPrimary');
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    try {
      const data = await api('/api/me/profile', {
        method: 'POST',
        body: JSON.stringify({ statusText: i1.value, bio: t2.value })
      });
      state.me = data.user;
      saveSession(state.token, state.me);
      renderMe();
      toast('Saved', 'Profile updated');
      closeModal();
    } catch (e) {
      toast('Save failed', e.message);
    }
  });

  const cancel = el('button', 'btn');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeModal);

  openModal('Edit Profile', [r1, r2], [save, cancel]);
}

function openPresenceModal() {
  const me = state.me;
  if (!me || !state.socket) return;

  const r = el('div', 'row');
  const lab = el('label'); lab.textContent = 'Presence';
  const sel = el('select');
  ['online','idle','dnd','invisible'].forEach(p => {
    const o = el('option'); o.value = p; o.textContent = p;
    if (me.presence === p) o.selected = true;
    sel.appendChild(o);
  });
  r.appendChild(lab); r.appendChild(sel);

  const save = el('button', 'btn btnPrimary');
  save.textContent = 'Set';
  save.addEventListener('click', async () => {
    const p = sel.value;
    try {
      // server also persists via socket presence:set (fast)
      state.socket.emit('presence:set', { presence: p }, () => {});
      await api('/api/me/profile', { method:'POST', body: JSON.stringify({ presence: p }) });
      toast('Presence', 'Updated');
      closeModal();
    } catch (e) {
      toast('Presence failed', e.message);
    }
  });

  const cancel = el('button', 'btn');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeModal);

  openModal('Set Presence', [r], [save, cancel]);
}

// ---------- Message edit/delete ----------

function openEditMessage(m) {
  const r = el('div', 'row');
  const lab = el('label'); lab.textContent = 'Edit';
  const t = el('textarea'); t.value = m.content || ''; t.maxLength = 1500;
  r.appendChild(lab); r.appendChild(t);

  const save = el('button', 'btn btnPrimary');
  save.textContent = 'Save';
  save.addEventListener('click', () => {
    state.socket.emit('message:edit', { messageId: m.id, content: t.value }, (ack) => {
      if (!ack || !ack.ok) return toast('Edit failed', ack?.error || 'error');
      closeModal();
    });
  });

  const cancel = el('button', 'btn');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeModal);

  openModal('Edit Message', [r], [save, cancel]);
}

function deleteMessage(m) {
  state.socket.emit('message:delete', { messageId: m.id }, (ack) => {
    if (!ack || !ack.ok) return toast('Delete failed', ack?.error || 'error');
  });
}

// ---------- New DM / Group ----------

async function createDM(username) {
  try {
    const data = await api('/api/threads/dm', { method:'POST', body: JSON.stringify({ username }) });
    await refreshThreads();
    closeModal();
    await openThread(data.threadId);
  } catch (e) {
    toast('DM failed', e.message);
  }
}

async function openNewModal() {
  const me = state.me;
  if (!me) return toast('Auth required', 'Login or guest first');
  if (me.isGuest) return toast('Guests', 'Guests cannot create DMs/groups');

  // Mode select
  const r = el('div', 'row');
  const lab = el('label'); lab.textContent = 'Type';
  const sel = el('select');
  const o1 = el('option'); o1.value='dm'; o1.textContent='DM';
  const o2 = el('option'); o2.value='group'; o2.textContent='Group';
  sel.appendChild(o1); sel.appendChild(o2);
  r.appendChild(lab); r.appendChild(sel);

  const wrap = el('div');
  wrap.style.display = 'flex';
  wrap.style.flexDirection = 'column';
  wrap.style.gap = '10px';

  const dmRow = el('div', 'row');
  const dmLab = el('label'); dmLab.textContent = 'Username';
  const dmIn = el('input'); dmIn.placeholder = 'e.g. alice';
  dmRow.appendChild(dmLab); dmRow.appendChild(dmIn);

  const gNameRow = el('div', 'row');
  const gNameLab = el('label'); gNameLab.textContent = 'Group name';
  const gNameIn = el('input'); gNameIn.placeholder = 'e.g. Raid Squad';
  gNameRow.appendChild(gNameLab); gNameRow.appendChild(gNameIn);

  const gMembersRow = el('div', 'row');
  const gMembersLab = el('label'); gMembersLab.textContent = 'Members';
  const gMembersIn = el('input'); gMembersIn.placeholder = 'Search users…';
  gMembersRow.appendChild(gMembersLab); gMembersRow.appendChild(gMembersIn);

  const pickWrap = el('div');
  pickWrap.style.display='flex';
  pickWrap.style.gap='6px';
  pickWrap.style.flexWrap='wrap';

  let picked = []; // user objects

  function renderPicked() {
    pickWrap.innerHTML = '';
    picked.forEach(u => {
      const b = el('button', 'btn');
      b.textContent = u.username + ' ✕';
      b.addEventListener('click', () => {
        picked = picked.filter(x => x.id !== u.id);
        renderPicked();
      });
      pickWrap.appendChild(b);
    });
  }

  let searchTimer = null;
  gMembersIn.addEventListener('input', () => {
    const q = gMembersIn.value.trim();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (!q) return;
      try {
        const data = await api('/api/users/search?q=' + encodeURIComponent(q));
        const list = data.users || [];
        // popup list
        const box = el('div');
        box.style.border = '1px solid var(--line)';
        box.style.borderRadius = '12px';
        box.style.overflow='hidden';
        box.style.background='rgba(255,255,255,.02)';

        list.forEach(u => {
          if (u.id === state.me.id) return;
          const it = el('div');
          it.style.padding='9px 10px';
          it.style.cursor='pointer';
          it.textContent = u.username;
          it.addEventListener('click', () => {
            if (!picked.some(x => x.id === u.id)) picked.push(u);
            renderPicked();
            box.remove();
            gMembersIn.value = '';
          });
          it.addEventListener('mouseenter', () => it.style.background='rgba(255,255,255,.04)');
          it.addEventListener('mouseleave', () => it.style.background='transparent');
          box.appendChild(it);
        });

        // Replace any existing box
        const prev = wrap.querySelector('[data-searchbox="1"]');
        if (prev) prev.remove();
        box.dataset.searchbox = '1';
        wrap.appendChild(box);
      } catch {}
    }, 220);
  });

  function renderMode() {
    wrap.innerHTML = '';
    wrap.appendChild(r);
    if (sel.value === 'dm') {
      wrap.appendChild(dmRow);
    } else {
      wrap.appendChild(gNameRow);
      wrap.appendChild(gMembersRow);
      wrap.appendChild(pickWrap);
      renderPicked();
    }
  }
  sel.addEventListener('change', renderMode);
  renderMode();

  const create = el('button', 'btn btnPrimary');
  create.textContent = 'Create';
  create.addEventListener('click', async () => {
    try {
      if (sel.value === 'dm') {
        await createDM(dmIn.value.trim());
        return;
      }
      const name = gNameIn.value.trim();
      const members = picked.map(u => u.id);
      const data = await api('/api/threads/group', { method:'POST', body: JSON.stringify({ name, members }) });
      await refreshThreads();
      closeModal();
      await openThread(data.threadId);
    } catch (e) {
      toast('Create failed', e.message);
    }
  });

  const cancel = el('button', 'btn');
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', closeModal);

  openModal('New Chat', [wrap], [create, cancel]);
}

// ---------- Auth modal ----------

function openAuthModal() {
  const tabs = el('div');
  tabs.style.display='flex';
  tabs.style.gap='8px';

  const mode = { v: 'login' };

  const btnLogin = el('button', 'btn btnPrimary');
  btnLogin.textContent='Login';
  const btnReg = el('button', 'btn');
  btnReg.textContent='Register';
  const btnGuest = el('button', 'btn');
  btnGuest.textContent='Guest';

  function setMode(v) {
    mode.v = v;
    btnLogin.classList.toggle('btnPrimary', v==='login');
    btnReg.classList.toggle('btnPrimary', v==='register');
    btnGuest.classList.toggle('btnPrimary', v==='guest');
    renderBody();
  }
  btnLogin.addEventListener('click', () => setMode('login'));
  btnReg.addEventListener('click', () => setMode('register'));
  btnGuest.addEventListener('click', () => setMode('guest'));
  tabs.append(btnLogin, btnReg, btnGuest);

  const body = el('div');
  body.style.display='flex';
  body.style.flexDirection='column';
  body.style.gap='10px';

  const uRow = el('div','row');
  const uLab = el('label'); uLab.textContent='Username';
  const uIn = el('input'); uIn.placeholder='2-20 chars';
  uRow.append(uLab,uIn);

  const pRow = el('div','row');
  const pLab = el('label'); pLab.textContent='Password';
  const pIn = el('input'); pIn.type='password'; pIn.placeholder='min 6 chars';
  pRow.append(pLab,pIn);

  function renderBody() {
    body.innerHTML='';
    body.appendChild(tabs);
    if (mode.v === 'guest') {
      const info = el('div');
      info.style.color='var(--muted)';
      info.style.fontSize='12px';
      info.textContent='Guests can chat in global (5s cooldown) but cannot DM, add friends, or create groups.';
      body.appendChild(info);
      return;
    }
    body.appendChild(uRow);
    body.appendChild(pRow);
  }
  renderBody();

  const go = el('button','btn btnPrimary');
  go.textContent='Continue';
  go.addEventListener('click', async () => {
    try {
      if (mode.v === 'guest') {
        const data = await fetch('/api/guest', { method:'POST' }).then(r => r.json());
        if (!data.token) throw new Error(data.error || 'guest failed');
        await finishAuth(data.token, data.user);
        closeModal();
        return;
      }
      const username = uIn.value.trim();
      const password = pIn.value;
      const endpoint = mode.v === 'register' ? '/api/register' : '/api/login';
      const data = await api(endpoint, { method:'POST', body: JSON.stringify({ username, password }) });
      await finishAuth(data.token, data.user);
      closeModal();
    } catch (e) {
      toast('Auth failed', e.message);
    }
  });

  const cancel = el('button','btn');
  cancel.textContent='Cancel';
  cancel.addEventListener('click', closeModal);

  openModal('Authenticate', [body], [go, cancel]);
}

async function finishAuth(token, me) {
  state.token = token;
  state.me = me;
  saveSession(token, me);
  renderMe();
  await refreshThreads();
  attachSocket();
  await openThread('global');
}

// ---------- Announcement modal ----------

function openAnnounceModal() {
  const me = state.me;
  if (!me || !me.badges?.includes('ANNOUNCEMENT')) return;

  const r = el('div','row');
  const lab = el('label'); lab.textContent='Message';
  const t = el('textarea'); t.placeholder='Announcement (global)'; t.maxLength=1500;
  r.append(lab,t);

  const send = el('button','btn btnPrimary');
  send.textContent='Send';
  send.addEventListener('click', async () => {
    try {
      await api('/api/announce', { method:'POST', body: JSON.stringify({ content: t.value }) });
      toast('Announcement', 'Sent');
      closeModal();
    } catch (e) {
      toast('Announce failed', e.message);
    }
  });

  const cancel = el('button','btn');
  cancel.textContent='Cancel';
  cancel.addEventListener('click', closeModal);

  openModal('Announcement', [r], [send, cancel]);
}

// ---------- Buttons ----------

UI.btnAuth.addEventListener('click', openAuthModal);
UI.btnProfile.addEventListener('click', () => {
  if (!state.me) return openAuthModal();
  openProfile(state.me);
});
UI.btnNew.addEventListener('click', openNewModal);
UI.btnLogout.addEventListener('click', () => {
  clearSession();
  location.reload();
});
UI.btnAnnounce.addEventListener('click', openAnnounceModal);

// ---------- Boot ----------

(async function boot() {
  loadSession();
  if (state.token) await ensureMe();
  renderMe();

  if (!state.me) {
    // Start logged out view; still show Global thread placeholder
    state.threads = [{ id:'global', type:'global', name:'Global', members:[], createdAt: Date.now() }];
    renderThreads();
    UI.threadTitle.textContent = '# global';
    UI.threadSub.textContent = 'Real-time chat';
    return;
  }

  await refreshThreads();
  attachSocket();
  await openThread(state.activeThreadId);
})();
