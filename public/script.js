(() => {
  "use strict";

  // Prevent double-load (fix duplicate messages/UI)
  if (window.__TONKOTSU_LOADED__) return;
  window.__TONKOTSU_LOADED__ = true;

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const safe = (v) => (typeof v === "string" ? v : "");
  const esc = (s) =>
    safe(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function uid(prefix = "id") {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  }

  function localGet(k, fb = null) {
    try {
      const v = localStorage.getItem(k);
      return v == null ? fb : JSON.parse(v);
    } catch {
      return fb;
    }
  }
  function localSet(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  }

  // DOM
  const dom = {
    loginWrap: $("#loginWrap"),
    loginUser: $("#loginUser"),
    loginPass: $("#loginPass"),
    loginMsg: $("#loginMsg"),
    btnLogin: $("#btnLogin"),
    btnGuest: $("#btnGuest"),

    loading: $("#loading"),
    loadMsg: $("#loadMsg"),
    loadTag: $("#loadTag"),

    app: $("#app"),
    btnUser: $("#btnUser"),
    btnLogout: $("#btnLogout"),

    threadList: $("#threadList"),
    searchThreads: $("#searchThreads"),
    btnAddFriend: $("#btnAddFriend"),
    btnNewGroup: $("#btnNewGroup"),

    centerH: $("#centerH"),
    centerS: $("#centerS"),
    centerBody: $("#centerBody"),

    composer: $("#composer"),
    msgInput: $("#msgInput"),
    btnSend: $("#btnSend"),
    typingText: $("#typingText"),
    cooldownBar: $("#cooldownBar"),
    cooldownText: $("#cooldownText"),

    onlineUsers: $("#onlineUsers"),
    presenceDot: $("#presenceDot"),
    presenceLabel: $("#presenceLabel"),
    btnPresenceOnline: $("#btnPresenceOnline"),
    btnPresenceIdle: $("#btnPresenceIdle"),
    btnPresenceDnd: $("#btnPresenceDnd"),
    btnPresenceInv: $("#btnPresenceInv"),
    btnSettings: $("#btnSettings"),

    backdrop: $("#backdrop"),
    modalTitle: $("#modalTitle"),
    modalBody: $("#modalBody"),
    modalFoot: $("#modalFoot"),
    modalClose: $("#modalClose"),

    ctx: $("#ctx"),
    cursor: $("#cursor"),
    trail: $("#trail")
  };

  // API
  async function api(path, { method = "GET", body = null } = {}) {
    const headers = { "Content-Type": "application/json" };
    if (state.session.token) headers.Authorization = `Bearer ${state.session.token}`;
    const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");
    const data = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");
    if (!res.ok) {
      const err = new Error((data && data.error) || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Toasts
  const toast = (() => {
    let wrap = null;
    function ensure() {
      if (wrap) return wrap;
      wrap = document.createElement("div");
      wrap.style.position = "fixed";
      wrap.style.right = "14px";
      wrap.style.bottom = "14px";
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.gap = "10px";
      wrap.style.zIndex = "9998";
      document.body.appendChild(wrap);
      return wrap;
    }
    function show(msg, kind = "info", ttl = 2200) {
      ensure();
      const el = document.createElement("div");
      el.style.padding = "10px 12px";
      el.style.borderRadius = "14px";
      el.style.border = "1px solid rgba(130,140,170,.22)";
      el.style.background = "rgba(10,12,16,.92)";
      el.style.color = "rgba(235,240,255,.92)";
      el.style.maxWidth = "320px";
      el.style.boxShadow = "0 10px 30px rgba(0,0,0,.45)";
      if (kind === "err") el.style.borderColor = "rgba(255,92,122,.35)";
      if (kind === "ok") el.style.borderColor = "rgba(120,255,190,.25)";
      if (kind === "warn") el.style.borderColor = "rgba(255,210,120,.25)";
      el.innerHTML = `<div>${esc(msg)}</div>`;
      wrap.appendChild(el);

      const kill = () => {
        el.style.opacity = "0";
        el.style.transform = "translateY(8px)";
        setTimeout(() => el.remove(), 180);
      };

      el.style.transition = "all 180ms ease";
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      requestAnimationFrame(() => {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
      });

      const id = setTimeout(kill, ttl);
      el.onclick = () => {
        clearTimeout(id);
        kill();
      };
    }
    return { show };
  })();

  // State
  const state = {
    session: {
      token: localGet("tk_token", null),
      user: localGet("tk_user", null)
    },
    ui: {
      activeThread: "global", // "global" | "dm:<pairKey>" | "group:<groupId>"
      sendingLock: false,
      cooldown: { until: 0, durationMs: 0 },
      onlineUsers: [],
      settings: localGet("tk_settings", {
        cursor: { enabled: true, size: 1.35, dynamic: true }
      }),
      firstJoinShown: !!localGet("tk_firstJoinShown", false),
      ctx: { open: false, threadKey: null, msgId: null }
    },
    data: {
      me: null,
      threads: {}, // key -> { kind,name,id?, messages:[] }
      friends: [],
      groups: []
    },
    socket: null
  };

  function showLoading(msg = "Loading…", tag = "boot") {
    if (dom.loadMsg) dom.loadMsg.textContent = msg;
    if (dom.loadTag) dom.loadTag.textContent = tag;
    dom.loading?.classList.add("show");
  }
  function hideLoading() {
    dom.loading?.classList.remove("show");
  }

  // Modal (single close button)
  function closeModal() {
    dom.backdrop?.classList.remove("show");
    if (dom.modalTitle) dom.modalTitle.textContent = "";
    if (dom.modalBody) dom.modalBody.innerHTML = "";
    if (dom.modalFoot) dom.modalFoot.innerHTML = "";
  }
  function openModal(title, bodyHtml, buttons = []) {
    if (dom.modalTitle) dom.modalTitle.textContent = title;
    if (dom.modalBody) dom.modalBody.innerHTML = bodyHtml;
    if (dom.modalFoot) dom.modalFoot.innerHTML = "";
    for (const b of buttons) {
      const btn = document.createElement("button");
      btn.className = `btn ${b.kind || ""}`.trim();
      btn.textContent = b.label;
      btn.onclick = () => b.onClick?.();
      dom.modalFoot.appendChild(btn);
    }
    dom.backdrop?.classList.add("show");
  }
  dom.modalClose?.addEventListener("click", closeModal);
  dom.backdrop?.addEventListener("click", (e) => {
    if (e.target === dom.backdrop) closeModal();
  });

  // Cursor (force-hide native cursor)
  function applyCursorMode() {
    const enabled = !!state.ui.settings.cursor?.enabled;
    if (enabled) {
      document.documentElement.style.cursor = "none";
      document.body.style.cursor = "none";
      if (!document.getElementById("__cursor_force")) {
        const st = document.createElement("style");
        st.id = "__cursor_force";
        st.textContent = `html, html * { cursor: none !important; } #cursor,#trail{pointer-events:none!important;}`;
        document.head.appendChild(st);
      }
      dom.cursor.style.display = "block";
      dom.trail.style.display = "block";
    } else {
      document.documentElement.style.cursor = "";
      document.body.style.cursor = "";
      dom.cursor.style.display = "none";
      dom.trail.style.display = "none";
    }
    localSet("tk_settings", state.ui.settings);
  }
  applyCursorMode();

  const cur = { x: innerWidth / 2, y: innerHeight / 2, tx: innerWidth / 2, ty: innerHeight / 2, vx: 0, vy: 0, over: false, down: false, last: now() };
  addEventListener("mousemove", (e) => { cur.tx = e.clientX; cur.ty = e.clientY; cur.last = now(); });
  addEventListener("mousedown", () => (cur.down = true));
  addEventListener("mouseup", () => (cur.down = false));
  addEventListener("mouseover", (e) => {
    const t = e.target;
    cur.over = !!(t && (t.closest("button") || t.closest("a") || t.closest("input") || t.closest("textarea") || t.closest("[role='button']") || t.closest(".thread") || t.closest(".msg")));
  }, true);

  function cursorTick() {
    if (!state.ui.settings.cursor?.enabled) return requestAnimationFrame(cursorTick);
    const dynamic = !!state.ui.settings.cursor?.dynamic;
    const base = Math.max(0.9, Math.min(2.0, state.ui.settings.cursor?.size || 1.35));
    const dx = cur.tx - cur.x, dy = cur.ty - cur.y;
    cur.vx = (cur.vx + dx * 0.18) * 0.62;
    cur.vy = (cur.vy + dy * 0.18) * 0.62;
    cur.x += cur.vx; cur.y += cur.vy;

    let scale = base;
    if (dynamic) {
      if (cur.over) scale *= 1.26;
      if (cur.down) scale *= 0.82;
      const idle = Math.min(1, (now() - cur.last) / 2200);
      scale *= (1 + idle * 0.09 * Math.sin(now() / 340));
    }

    dom.cursor.style.transform = `translate(${cur.x}px,${cur.y}px) translate(-50%,-50%) scale(${scale})`;
    const tx = cur.x - cur.vx * 2.2, ty = cur.y - cur.vy * 2.2;
    const speed = Math.min(1, Math.hypot(cur.vx, cur.vy) / 26);
    dom.trail.style.transform = `translate(${tx}px,${ty}px) translate(-50%,-50%)`;
    dom.trail.style.opacity = String(0.16 + speed * 0.55);

    requestAnimationFrame(cursorTick);
  }
  requestAnimationFrame(cursorTick);

  // Cooldown bar
  function setCooldown(untilTs, durationMs = 0) {
    state.ui.cooldown.until = untilTs || 0;
    if (durationMs) state.ui.cooldown.durationMs = durationMs;
  }
  function flashCooldownViolation() {
    dom.composer?.classList.remove("cd-red", "cd-shake");
    void dom.composer?.offsetWidth;
    dom.composer?.classList.add("cd-red", "cd-shake");
    setTimeout(() => dom.composer?.classList.remove("cd-red"), 520);
    setTimeout(() => dom.composer?.classList.remove("cd-shake"), 620);
  }
  function updateCooldownUi() {
    const until = state.ui.cooldown.until || 0;
    const active = until && now() < until;
    if (!active) {
      dom.cooldownText.textContent = "";
      dom.cooldownBar.style.width = "0%";
      dom.cooldownBar.style.opacity = "0";
      return;
    }
    const left = until - now();
    dom.cooldownText.textContent = `cooldown: ${Math.ceil(left / 1000)}s`;
    const dur = state.ui.cooldown.durationMs || 3000;
    const start = until - dur;
    const pct = Math.max(0, Math.min(100, ((now() - start) / dur) * 100));
    dom.cooldownBar.style.opacity = "1";
    dom.cooldownBar.style.width = `${pct}%`;
  }
  setInterval(updateCooldownUi, 120);

  // Login
  function setLoginMsg(msg, err = false) {
    dom.loginMsg.textContent = msg;
    dom.loginMsg.style.color = err ? "rgba(255,92,122,.95)" : "";
  }
  function showLogin() {
    dom.app.style.display = "none";
    dom.loginWrap.style.display = "flex";
    hideLoading();
    applyCursorMode();

    if (!state.ui.firstJoinShown) {
      state.ui.firstJoinShown = true;
      localSet("tk_firstJoinShown", true);
      openModal(
        "Welcome to tonkotsu.online (beta)",
        `<div style="color:rgba(154,163,183,.85);font-size:13px;line-height:1.5">
          This is a beta build. Features may change and bugs can happen.<br><br>
          Early Access badges can be assigned by the server.
        </div>`,
        []
      );
    }
  }
  function showApp() {
    dom.loginWrap.style.display = "none";
    dom.app.style.display = "flex";
    applyCursorMode();
  }

  async function doLogin(username, password) {
    setLoginMsg("Signing in…");
    try {
      const r = await api("/api/auth/login", { method: "POST", body: { username, password } });
      if (!r?.ok || !r.token) throw new Error(r?.error || "Login failed");
      state.session.token = r.token;
      state.session.user = r.user;
      localSet("tk_token", r.token);
      localSet("tk_user", r.user);
      await afterAuth();
    } catch (e) {
      setLoginMsg(e.message || "Login failed", true);
      toast.show("Sign-in failed.", "err");
    }
  }

  async function doGuest() {
    setLoginMsg("Starting guest…");
    try {
      const r = await api("/api/auth/guest", { method: "POST", body: {} });
      if (!r?.ok || !r.token) throw new Error(r?.error || "Guest failed");
      state.session.token = r.token;
      state.session.user = r.user;
      localSet("tk_token", r.token);
      localSet("tk_user", r.user);
      await afterAuth();
    } catch (e) {
      setLoginMsg(e.message || "Guest failed", true);
      toast.show("Guest sign-in failed.", "err");
    }
  }

  async function doLogout() {
    try {
      await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    } finally {
      try {
        state.socket?.removeAllListeners?.();
        state.socket?.disconnect?.();
      } catch {}
      state.socket = null;
      state.session.token = null;
      state.session.user = null;
      localSet("tk_token", null);
      localSet("tk_user", null);
      showLogin();
    }
  }

  dom.btnLogin.addEventListener("click", () => doLogin(dom.loginUser.value.trim(), dom.loginPass.value));
  dom.btnGuest.addEventListener("click", () => doGuest());
  dom.loginPass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") dom.btnLogin.click();
  });
  dom.btnLogout.addEventListener("click", doLogout);

  // Threads
  function ensureThread(key, meta) {
    if (!state.data.threads[key]) state.data.threads[key] = { ...meta, messages: [] };
    return state.data.threads[key];
  }

  function threadName(t) {
    if (t.kind === "global") return "Global";
    if (t.kind === "dm") return `@${t.name}`;
    if (t.kind === "group") return `#${t.name}`;
    return t.name || "Thread";
  }

  function lastPreview(t) {
    const m = t.messages?.[t.messages.length - 1];
    return m ? safe(m.text).slice(0, 80) : "No messages yet.";
  }

  function setCenterHeader(key) {
    const t = state.data.threads[key];
    if (!t) return;
    dom.centerH.textContent = threadName(t);
    dom.centerS.textContent = t.kind === "global" ? "" : (t.kind === "dm" ? "Direct message" : "Group chat");
  }

  function renderThreadList() {
    const q = dom.searchThreads.value.trim().toLowerCase();
    const keys = Object.keys(state.data.threads);

    keys.sort((a, b) => {
      const A = state.data.threads[a], B = state.data.threads[b];
      const pr = (t) => (t.kind === "global" ? 0 : t.kind === "dm" ? 1 : 2);
      const d = pr(A) - pr(B);
      if (d) return d;
      return threadName(A).localeCompare(threadName(B));
    });

    dom.threadList.innerHTML = "";
    for (const k of keys) {
      const t = state.data.threads[k];
      const name = threadName(t);
      if (q && !name.toLowerCase().includes(q)) continue;

      const el = document.createElement("div");
      el.className = "thread" + (state.ui.activeThread === k ? " active" : "");
      el.innerHTML = `
        <div class="threadTop">
          <div class="threadName">${esc(name)}</div>
          <div class="threadMeta">${esc(t.kind)}</div>
        </div>
        <div class="threadLast">${esc(lastPreview(t))}</div>
      `;
      el.addEventListener("click", () => {
        state.ui.activeThread = k;
        renderThreadList();
        renderMessages(k);
      });
      dom.threadList.appendChild(el);
    }
  }

  function renderMessages(key) {
    const t = state.data.threads[key];
    if (!t) return;

    setCenterHeader(key);
    dom.centerBody.innerHTML = "";

    if (!t.messages.length) {
      dom.centerBody.innerHTML = `<div class="msg"><div class="msgBody">No messages. Send the first message.</div></div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const m of t.messages) {
      const el = document.createElement("div");
      el.className = "msg";
      el.dataset.id = m.id;

      const uname = esc(m.user?.username || "user");
      const color = m.user?.color || "rgba(235,240,255,.92)";
      const ts = new Date(m.ts || now());
      const time = `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`;

      const chips = [];
      if (m.kind === "announcement") chips.push(`<span class="chip ann">ANNOUNCEMENT</span>`);
      if (m.pending) chips.push(`<span class="chip">sending</span>`);
      if (m.failed) chips.push(`<span class="chip err">failed</span>`);
      if (m.editedAt) chips.push(`<span class="chip">edited</span>`);

      el.innerHTML = `
        <div class="msgTop">
          <div class="msgUser" style="color:${esc(color)}">${uname}</div>
          <div class="msgTime">${esc(time)}</div>
        </div>
        <div class="msgBody">${esc(m.text)}</div>
        <div class="chips">${chips.join("")}</div>
      `;

      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMessageContextMenu(e.clientX, e.clientY, key, m);
      });

      el.addEventListener("click", () => openProfile(m.user));

      frag.appendChild(el);
    }

    dom.centerBody.appendChild(frag);
    dom.centerBody.scrollTop = dom.centerBody.scrollHeight;
  }

  // Context menu
  function closeCtx() {
    state.ui.ctx.open = false;
    dom.ctx.classList.remove("show");
    dom.ctx.innerHTML = "";
  }
  document.addEventListener("click", () => state.ui.ctx.open && closeCtx());
  window.addEventListener("resize", () => state.ui.ctx.open && closeCtx());

  function openMessageContextMenu(x, y, threadKey, m) {
    closeCtx();

    const mine =
      (m.user?.id && state.data.me?.id && m.user.id === state.data.me.id) ||
      (m.user?.username && state.data.me?.username && m.user.username === state.data.me.username);

    const age = now() - (m.ts || 0);
    const canEdit = mine && age <= 60_000;

    const items = [];
    if (canEdit) {
      items.push({ label: "Edit (1 min)", onClick: () => { closeCtx(); promptEdit(threadKey, m); } });
      items.push({ label: "Delete (1 min)", danger: true, onClick: () => { closeCtx(); promptDelete(m); } });
    }
    items.push({ label: "Report", danger: true, onClick: () => { closeCtx(); promptReport(m); } });

    dom.ctx.innerHTML = items.map((it, i) => `
      <div class="item ${it.danger ? "danger" : ""}" data-i="${i}">
        <span>${esc(it.label)}</span>
        <span style="opacity:.7">${it.danger ? "!" : ""}</span>
      </div>
    `).join("");

    $$(".item", dom.ctx).forEach((n) => {
      const i = Number(n.dataset.i);
      n.addEventListener("click", () => items[i]?.onClick?.());
    });

    const vw = innerWidth, vh = innerHeight;
    const w = 220, h = items.length * 44;
    const px = Math.max(10, Math.min(vw - w - 10, x));
    const py = Math.max(10, Math.min(vh - h - 10, y));

    dom.ctx.style.left = px + "px";
    dom.ctx.style.top = py + "px";
    dom.ctx.classList.add("show");
    state.ui.ctx.open = true;
    state.ui.ctx.threadKey = threadKey;
    state.ui.ctx.msgId = m.id;
  }

  function promptEdit(threadKey, m) {
    openModal(
      "Edit message",
      `<div style="color:rgba(154,163,183,.85);font-size:13px;margin-bottom:10px">Edits allowed within 1 minute.</div>
       <textarea id="editText" class="input" rows="4">${esc(m.text || "")}</textarea>`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Save", kind: "primary", onClick: async () => {
          const text = $("#editText").value.trim();
          if (!text) return;
          await editMessage(m.id, text);
          closeModal();
        } }
      ]
    );
  }

  function promptDelete(m) {
    openModal(
      "Delete message",
      `<div style="color:rgba(154,163,183,.85);font-size:13px">Delete this message? (1 minute window)</div>`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Delete", kind: "danger", onClick: async () => {
          await deleteMessage(m.id);
          closeModal();
        } }
      ]
    );
  }

  function promptReport(m) {
    openModal(
      "Report message",
      `<div style="color:rgba(154,163,183,.85);font-size:13px;margin-bottom:10px">
        This sends a report to moderation.
      </div>
      <input id="reportReason" class="input" placeholder="Reason (optional)" />`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Report", kind: "danger", onClick: async () => {
          const reason = $("#reportReason").value.trim();
          await reportMessage(m.id, reason);
          closeModal();
        } }
      ]
    );
  }

  // Profile
  function openProfile(user) {
    if (!user) return;
    const created = user.createdAt ? new Date(user.createdAt).toLocaleString() : "—";
    const lastSeen = user.lastSeen ? new Date(user.lastSeen).toLocaleString() : "—";
    const bio = user.bio ? esc(user.bio) : `<span style="color:rgba(154,163,183,.75)">No bio.</span>`;
    openModal(
      user.username || "Profile",
      `<div style="display:flex;flex-direction:column;gap:10px">
        <div><b>Bio</b><div style="margin-top:6px;color:rgba(235,240,255,.9)">${bio}</div></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div><b>Created</b><div style="color:rgba(154,163,183,.85);margin-top:6px">${esc(created)}</div></div>
          <div><b>Last seen</b><div style="color:rgba(154,163,183,.85);margin-top:6px">${esc(lastSeen)}</div></div>
        </div>
      </div>`,
      [
        ...(user.id === state.data.me?.id ? [{
          label: "Edit bio",
          kind: "primary",
          onClick: () => openBioEditor()
        }] : [])
      ]
    );
  }

  function openBioEditor() {
    const me = state.data.me || state.session.user || {};
    openModal(
      "Edit bio",
      `<div style="color:rgba(154,163,183,.85);font-size:13px;margin-bottom:10px">Max 220 chars.</div>
       <textarea id="bioText" class="input" rows="4">${esc(me.bio || "")}</textarea>`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Save", kind: "primary", onClick: async () => {
          const bio = $("#bioText").value || "";
          try {
            const r = await api("/api/users/bio", { method: "POST", body: { bio } });
            if (r?.ok && r.user) {
              state.data.me = r.user;
              state.session.user = r.user;
              localSet("tk_user", r.user);
              toast.show("Bio updated.", "ok");
            }
          } catch (e) {
            toast.show(e.message || "Bio failed", "err");
          }
          closeModal();
        } }
      ]
    );
  }

  dom.btnUser.addEventListener("click", () => openProfile(state.data.me || state.session.user));

  // Messaging actions
  function activeThreadInfo() {
    const key = state.ui.activeThread;
    if (key === "global") return { scope: "global", targetId: null };
    if (key.startsWith("dm:")) return { scope: "dm", targetId: key.slice(3) };       // pairKey
    if (key.startsWith("group:")) return { scope: "group", targetId: key.slice(6) }; // groupId
    return { scope: "global", targetId: null };
  }

  function inCooldown() {
    return state.ui.cooldown.until && now() < state.ui.cooldown.until;
  }

  async function sendMessage() {
    const text = dom.msgInput.value.trim();
    if (!text) return;

    if (inCooldown()) {
      flashCooldownViolation();
      toast.show("Cooldown active.", "warn", 1200);
      return;
    }

    if (state.ui.sendingLock) return;
    state.ui.sendingLock = true;

    const { scope, targetId } = activeThreadInfo();
    const clientId = uid("c");

    // optimistic
    const thread = state.data.threads[state.ui.activeThread];
    const localId = uid("m");
    thread.messages.push({
      id: localId,
      ts: now(),
      text,
      user: state.data.me || state.session.user,
      pending: true
    });

    dom.msgInput.value = "";
    renderMessages(state.ui.activeThread);

    const attempt = async (n) => {
      try {
        const r = await api("/api/messages/send", { method: "POST", body: { scope, targetId, text, clientId } });
        if (r?.cooldownUntil) setCooldown(r.cooldownUntil, r.cooldownMs || 0);

        // replace local optimistic
        const idx = thread.messages.findIndex((x) => x.id === localId);
        if (idx >= 0 && r?.message) thread.messages[idx] = r.message;

        renderMessages(state.ui.activeThread);
        state.ui.sendingLock = false;
      } catch (e) {
        const transient = [0, 502, 503, 504].includes(e.status || 0);
        if (transient && n < 2) {
          await sleep(250 * (n + 1));
          return attempt(n + 1);
        }
        const idx = thread.messages.findIndex((x) => x.id === localId);
        if (idx >= 0) {
          thread.messages[idx].failed = true;
          thread.messages[idx].pending = false;
        }
        renderMessages(state.ui.activeThread);
        toast.show(e.message || "Send failed", "err");
        state.ui.sendingLock = false;
      }
    };

    await attempt(0);
  }

  dom.btnSend.addEventListener("click", sendMessage);
  dom.msgInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  async function editMessage(messageId, text) {
    try {
      const r = await api("/api/messages/edit", { method: "POST", body: { messageId, text } });
      if (r?.ok && r.message) {
        applyEdited(r.message);
        toast.show("Edited.", "ok", 1200);
      }
    } catch (e) {
      toast.show(e.message || "Edit failed", "err");
    }
  }

  async function deleteMessage(messageId) {
    try {
      const r = await api("/api/messages/delete", { method: "POST", body: { messageId } });
      if (r?.ok) toast.show("Deleted.", "ok", 1200);
    } catch (e) {
      toast.show(e.message || "Delete failed", "err");
    }
  }

  async function reportMessage(messageId, reason) {
    try {
      const r = await api("/api/messages/report", { method: "POST", body: { messageId, reason } });
      if (r?.ok) toast.show("Reported.", "ok", 1200);
    } catch (e) {
      toast.show(e.message || "Report failed", "err");
    }
  }

  function applyEdited(message) {
    for (const k of Object.keys(state.data.threads)) {
      const t = state.data.threads[k];
      const idx = t.messages.findIndex((x) => x.id === message.id);
      if (idx >= 0) {
        t.messages[idx] = message;
        if (state.ui.activeThread === k) renderMessages(k);
        return;
      }
    }
  }

  function applyDeleted(messageId) {
    for (const k of Object.keys(state.data.threads)) {
      const t = state.data.threads[k];
      const idx = t.messages.findIndex((x) => x.id === messageId);
      if (idx >= 0) {
        t.messages.splice(idx, 1);
        if (state.ui.activeThread === k) renderMessages(k);
        return;
      }
    }
  }

  // Friends + groups buttons
  dom.searchThreads.addEventListener("input", () => renderThreadList());

  dom.btnAddFriend.addEventListener("click", () => {
    openModal(
      "Add friend",
      `<div style="color:rgba(154,163,183,.85);font-size:13px;margin-bottom:10px">Enter username.</div>
       <input id="friendName" class="input" placeholder="username" />`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Add", kind: "primary", onClick: async () => {
          const username = $("#friendName").value.trim();
          if (!username) return;
          try {
            await api("/api/friends/add", { method: "POST", body: { username } });
            toast.show("Friend added.", "ok");
            closeModal();
            await bootstrap();
          } catch (e) {
            toast.show(e.message || "Add failed", "err");
          }
        } }
      ]
    );
  });

  dom.btnNewGroup.addEventListener("click", () => {
    openModal(
      "Create group",
      `<div style="display:flex;flex-direction:column;gap:10px">
        <input id="groupName" class="input" placeholder="group name" />
        <input id="groupCooldown" class="input" placeholder="cooldown seconds (default 3)" />
      </div>`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Create", kind: "primary", onClick: async () => {
          const name = $("#groupName").value.trim();
          const cooldownSeconds = Number($("#groupCooldown").value || 3);
          if (!name) return;
          try {
            await api("/api/groups/create", { method: "POST", body: { name, cooldownSeconds } });
            toast.show("Group created.", "ok");
            closeModal();
            await bootstrap();
          } catch (e) {
            toast.show(e.message || "Create failed", "err");
          }
        } }
      ]
    );
  });

  // Settings modal
  dom.btnSettings.addEventListener("click", () => {
    const s = state.ui.settings.cursor || {};
    openModal(
      "Settings",
      `<div style="display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:900">Custom cursor</div>
            <div style="color:rgba(154,163,183,.85);font-size:13px;margin-top:4px">Hides system cursor and uses circle + trail.</div>
          </div>
          <button id="toggleCursor" class="btn mini">${s.enabled ? "on" : "off"}</button>
        </div>

        <div style="display:flex;align-items:center;justify-content:space-between;gap:10px">
          <div>
            <div style="font-weight:900">Cursor dynamic</div>
            <div style="color:rgba(154,163,183,.85);font-size:13px;margin-top:4px">Grows on hover, shrinks on click.</div>
          </div>
          <button id="toggleDynamic" class="btn mini">${s.dynamic ? "on" : "off"}</button>
        </div>

        <div>
          <div style="font-weight:900;margin-bottom:6px">Cursor size</div>
          <input id="cursorSize" class="input" placeholder="1.35" value="${esc(String(s.size ?? 1.35))}" />
        </div>
      </div>`,
      [
        { label: "Close", onClick: closeModal },
        { label: "Save", kind: "primary", onClick: () => {
          const size = Number($("#cursorSize").value || 1.35);
          state.ui.settings.cursor = state.ui.settings.cursor || {};
          state.ui.settings.cursor.size = Math.max(0.9, Math.min(2.0, size));
          localSet("tk_settings", state.ui.settings);
          applyCursorMode();
          closeModal();
          toast.show("Saved.", "ok", 1200);
        } }
      ]
    );

    setTimeout(() => {
      $("#toggleCursor")?.addEventListener("click", () => {
        state.ui.settings.cursor.enabled = !state.ui.settings.cursor.enabled;
        $("#toggleCursor").textContent = state.ui.settings.cursor.enabled ? "on" : "off";
        localSet("tk_settings", state.ui.settings);
        applyCursorMode();
      });
      $("#toggleDynamic")?.addEventListener("click", () => {
        state.ui.settings.cursor.dynamic = !state.ui.settings.cursor.dynamic;
        $("#toggleDynamic").textContent = state.ui.settings.cursor.dynamic ? "on" : "off";
        localSet("tk_settings", state.ui.settings);
      });
    }, 0);
  });

  // Presence buttons
  function setPresenceUi(mode) {
    dom.presenceDot.classList.remove("idle", "dnd", "inv");
    if (mode === "idle") dom.presenceDot.classList.add("idle");
    if (mode === "dnd") dom.presenceDot.classList.add("dnd");
    if (mode === "invisible") dom.presenceDot.classList.add("inv");
    dom.presenceLabel.textContent = mode;
  }

  function setPresence(mode) {
    setPresenceUi(mode);
    state.socket?.emit("presence:set", { mode });
  }

  dom.btnPresenceOnline.addEventListener("click", () => setPresence("online"));
  dom.btnPresenceIdle.addEventListener("click", () => setPresence("idle"));
  dom.btnPresenceDnd.addEventListener("click", () => setPresence("dnd"));
  dom.btnPresenceInv.addEventListener("click", () => setPresence("invisible"));

  // Online users render
  function renderOnlineUsers() {
    dom.onlineUsers.innerHTML = "";
    for (const u of state.ui.onlineUsers.slice(0, 80)) {
      const el = document.createElement("div");
      el.className = "miniUser";
      const dotCls = u.mode === "idle" ? "idle" : u.mode === "dnd" ? "dnd" : u.mode === "invisible" ? "inv" : "";
      el.innerHTML = `
        <span class="miniDot ${dotCls}"></span>
        <div style="min-width:0">
          <div class="miniName" style="color:${esc(u.color || "rgba(235,240,255,.92)")}">${esc(u.username)}</div>
          <div class="miniMode">${esc(u.mode || "online")}</div>
        </div>
      `;
      el.addEventListener("click", () => openProfile(u));
      dom.onlineUsers.appendChild(el);
    }
  }

  // Bootstrap
  async function bootstrap() {
    showLoading("Loading…", "state");

    const data = await api("/api/state/bootstrap", { method: "GET" });
    if (!data?.ok) throw new Error("bootstrap failed");

    state.data.me = data.me;
    state.session.user = data.me;
    localSet("tk_user", data.me);

    // Reset threads
    state.data.threads = {};
    ensureThread("global", { kind: "global", name: "Global" }).messages = Array.isArray(data.global?.messages) ? data.global.messages : [];

    // friends/dms
    state.data.friends = Array.isArray(data.friends) ? data.friends : [];
    const dms = Array.isArray(data.dms) ? data.dms : [];
    for (const th of dms) {
      const pairKey = th.pairKey;
      const peer = th.peer;
      const key = `dm:${pairKey}`;
      const t = ensureThread(key, { kind: "dm", name: peer.username, id: pairKey, peer });
      t.messages = Array.isArray(th.messages) ? th.messages : [];
    }

    // groups
    state.data.groups = Array.isArray(data.groups) ? data.groups : [];
    const gts = Array.isArray(data.groupThreads) ? data.groupThreads : [];
    for (const gt of gts) {
      const g = gt.group;
      const key = `group:${g.id}`;
      const t = ensureThread(key, { kind: "group", name: g.name, id: g.id, group: g });
      t.messages = Array.isArray(gt.messages) ? gt.messages : [];
    }

    // default thread
    if (!state.data.threads[state.ui.activeThread]) state.ui.activeThread = "global";

    renderThreadList();
    renderMessages(state.ui.activeThread);

    hideLoading();
  }

  // Socket
  async function initSocket() {
    if (!window.io) return;
    if (state.socket) {
      try {
        state.socket.removeAllListeners();
        state.socket.disconnect();
      } catch {}
    }

    const socket = io({
      transports: ["websocket", "polling"],
      auth: { token: state.session.token }
    });
    state.socket = socket;

    socket.on("connect_error", (e) => {
      toast.show(e.message || "Socket error", "err", 1600);
    });

    socket.on("users:online", (p) => {
      state.ui.onlineUsers = Array.isArray(p?.users) ? p.users : [];
      renderOnlineUsers();
    });

    socket.on("typing:update", (p) => {
      const { scope, targetId } = activeThreadInfo();
      if (!p) return;
      if (p.scope !== scope) return;
      if ((p.targetId || null) !== (targetId || null)) return;
      if (p.user?.username === state.data.me?.username) return;

      dom.typingText.textContent = `${p.user?.username || "someone"} typing…`;
      setTimeout(() => {
        if (dom.typingText.textContent.includes("typing")) dom.typingText.textContent = "";
      }, 1200);
    });

    socket.on("message:new", (payload) => {
      const m = payload?.message;
      const scope = payload?.scope;
      const targetId = payload?.targetId || null;
      if (!m || !scope) return;

      if (scope === "global") {
        state.data.threads.global.messages.push(m);
        if (state.ui.activeThread === "global") renderMessages("global");
        renderThreadList();
        return;
      }

      if (scope === "dm") {
        const key = `dm:${targetId}`; // targetId is pairKey
        if (!state.data.threads[key]) return;
        state.data.threads[key].messages.push(m);
        if (state.ui.activeThread === key) renderMessages(key);
        renderThreadList();
        return;
      }

      if (scope === "group") {
        const key = `group:${targetId}`;
        if (!state.data.threads[key]) return;
        state.data.threads[key].messages.push(m);
        if (state.ui.activeThread === key) renderMessages(key);
        renderThreadList();
      }
    });

    socket.on("message:edit", (p) => {
      const m = p?.message;
      if (!m) return;
      applyEdited(m);
    });

    socket.on("message:delete", (p) => {
      if (!p?.messageId) return;
      applyDeleted(p.messageId);
    });
  }

  async function afterAuth() {
    showApp();
    await bootstrap();
    await initSocket();
    toast.show("Signed in.", "ok", 1200);
  }

  // Initial
  (async () => {
    if (!state.session.token) return showLogin();

    try {
      showApp();
      await bootstrap();
      await initSocket();
    } catch {
      state.session.token = null;
      localSet("tk_token", null);
      showLogin();
    }
  })();
})();
