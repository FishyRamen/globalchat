(() => {
  "use strict";

  // Prevent double-load (stops duplicate messages/UI)
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
    linkGithub: $("#linkGithub"),
    linkKofi: $("#linkKofi"),

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

  // Toasts (small, click to dismiss)
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
      el.style.maxWidth = "340px";
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
      user: localGet("tk_user", null),
    },
    ui: {
      activeThread: "global", // global | dm:<peerId> | group:<groupId>
      sendingLock: false,
      cooldown: { until: 0, durationMs: 0 },
      typingTimer: null,
      typingUsers: [],
      onlineUsers: [],
      settings: localGet("tk_settings", {
        cursor: { enabled: true, size: 1.35, dynamic: true },
      }),
      firstJoinShown: !!localGet("tk_firstJoinShown", false),
      ctx: { open: false, threadKey: null, msgId: null },
    },
    data: {
      me: null,
      threads: {}, // key -> { kind, id, name, messages:[] }
      friends: [],
      groups: [],
    },
    socket: null,
  };

  // Loading overlay
  function showLoading(msg = "Loading…", tag = "boot") {
    if (dom.loadMsg) dom.loadMsg.textContent = msg;
    if (dom.loadTag) dom.loadTag.textContent = tag;
    dom.loading?.classList.add("show");
  }
  function hideLoading() {
    dom.loading?.classList.remove("show");
  }

  // Modal (single close button only)
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

  // Custom cursor (force hide system cursor everywhere)
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
      if (dom.cursor) dom.cursor.style.display = "block";
      if (dom.trail) dom.trail.style.display = "block";
    } else {
      document.documentElement.style.cursor = "";
      document.body.style.cursor = "";
      if (dom.cursor) dom.cursor.style.display = "none";
      if (dom.trail) dom.trail.style.display = "none";
    }
    localSet("tk_settings", state.ui.settings);
  }
  applyCursorMode();

  // Cursor dynamics with visible trail
  const cur = {
    x: innerWidth / 2,
    y: innerHeight / 2,
    tx: innerWidth / 2,
    ty: innerHeight / 2,
    vx: 0,
    vy: 0,
    over: false,
    down: false,
    last: now(),
  };
  addEventListener("mousemove", (e) => {
    cur.tx = e.clientX;
    cur.ty = e.clientY;
    cur.last = now();
  });
  addEventListener("mousedown", () => (cur.down = true));
  addEventListener("mouseup", () => (cur.down = false));
  addEventListener(
    "mouseover",
    (e) => {
      const t = e.target;
      cur.over = !!(
        t &&
        (t.closest("button") ||
          t.closest("a") ||
          t.closest("input") ||
          t.closest("textarea") ||
          t.closest("[role='button']") ||
          t.closest(".thread") ||
          t.closest(".msg") ||
          t.closest(".uRow"))
      );
    },
    true
  );

  function cursorTick() {
    if (!state.ui.settings.cursor?.enabled) return requestAnimationFrame(cursorTick);

    const dynamic = !!state.ui.settings.cursor?.dynamic;
    const base = Math.max(0.9, Math.min(2.0, state.ui.settings.cursor?.size || 1.35));
    const dx = cur.tx - cur.x,
      dy = cur.ty - cur.y;

    cur.vx = (cur.vx + dx * 0.18) * 0.62;
    cur.vy = (cur.vy + dy * 0.18) * 0.62;
    cur.x += cur.vx;
    cur.y += cur.vy;

    let scale = base;
    if (dynamic) {
      if (cur.over) scale *= 1.26;
      if (cur.down) scale *= 0.82;
      const idle = Math.min(1, (now() - cur.last) / 2200);
      scale *= 1 + idle * 0.09 * Math.sin(now() / 340);
    }

    if (dom.cursor) dom.cursor.style.transform = `translate(${cur.x}px,${cur.y}px) translate(-50%,-50%) scale(${scale})`;

    const tx = cur.x - cur.vx * 2.2,
      ty = cur.y - cur.vy * 2.2;
    const speed = Math.min(1, Math.hypot(cur.vx, cur.vy) / 26);
    if (dom.trail) {
      dom.trail.style.transform = `translate(${tx}px,${ty}px) translate(-50%,-50%)`;
      dom.trail.style.opacity = String(0.16 + speed * 0.55);
    }

    requestAnimationFrame(cursorTick);
  }
  requestAnimationFrame(cursorTick);

  // Cooldown UI (bar + red shake if violated)
  function setCooldown(untilTs, durationMs = 0) {
    state.ui.cooldown.until = untilTs || 0;
    if (durationMs) state.ui.cooldown.durationMs = durationMs;
  }
  function flashCooldownViolation() {
    const el = dom.composer;
    if (!el) return;
    el.classList.remove("cd-red", "cd-shake");
    void el.offsetWidth;
    el.classList.add("cd-red", "cd-shake");
    setTimeout(() => el.classList.remove("cd-red"), 520);
    setTimeout(() => el.classList.remove("cd-shake"), 620);
  }
  function updateCooldownUi() {
    const until = state.ui.cooldown.until || 0;
    const active = until && now() < until;

    if (!active) {
      if (dom.cooldownText) dom.cooldownText.textContent = "";
      if (dom.cooldownBar) {
        dom.cooldownBar.style.width = "0%";
        dom.cooldownBar.style.opacity = "0";
      }
      return;
    }

    const left = until - now();
    if (dom.cooldownText) dom.cooldownText.textContent = `cooldown: ${Math.ceil(left / 1000)}s`;

    const dur = state.ui.cooldown.durationMs || 5000;
    const start = until - dur;
    const pct = Math.max(0, Math.min(100, ((now() - start) / dur) * 100));

    if (dom.cooldownBar) {
      dom.cooldownBar.style.opacity = "1";
      dom.cooldownBar.style.width = `${pct}%`;
    }
  }
  setInterval(updateCooldownUi, 120);

  // Presence UI
  function setPresenceUi(mode) {
    if (!dom.presenceDot || !dom.presenceLabel) return;
    dom.presenceDot.classList.remove("idle", "dnd", "inv");
    if (mode === "idle") dom.presenceDot.classList.add("idle");
    else if (mode === "dnd") dom.presenceDot.classList.add("dnd");
    else if (mode === "invisible") dom.presenceDot.classList.add("inv");
    dom.presenceLabel.textContent = mode || "online";
  }

  // Thread helpers
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

  function activeThreadInfo() {
    const k = state.ui.activeThread;
    if (k === "global") return { kind: "global", id: null, key: "global" };
    if (k.startsWith("dm:")) return { kind: "dm", id: k.slice(3), key: k };
    if (k.startsWith("group:")) return { kind: "group", id: k.slice(6), key: k };
    return { kind: "global", id: null, key: "global" };
  }

  // Render left thread list
  function renderThreadList() {
    const q = safe(dom.searchThreads?.value).trim().toLowerCase();
    const keys = Object.keys(state.data.threads);

    const sorted = keys.sort((a, b) => {
      const A = state.data.threads[a],
        B = state.data.threads[b];
      const pr = (t) => (t.kind === "global" ? 0 : t.kind === "dm" ? 1 : 2);
      const pa = pr(A) - pr(B);
      if (pa) return pa;
      return threadName(A).localeCompare(threadName(B));
    });

    const frag = document.createDocumentFragment();
    for (const k of sorted) {
      const t = state.data.threads[k];
      const name = threadName(t);
      if (q && !name.toLowerCase().includes(q)) continue;

      const el = document.createElement("div");
      el.className = "thread" + (state.ui.activeThread === k ? " active" : "");
      el.innerHTML = `
        <div class="threadTop">
          <div class="threadName">${esc(name)}</div>
          <div class="threadKind">${esc(t.kind)}</div>
        </div>
        <div class="threadLast">${esc(lastPreview(t))}</div>
      `;
      el.addEventListener("click", async () => {
        state.ui.activeThread = k;
        renderThreadList();
        renderMessages(k);
        // notify server which DM/group we opened for typing/read routing
        if (state.socket) {
          const info = activeThreadInfo();
          if (info.kind === "dm") state.socket.emit("dm:open", { peerId: info.id });
          if (info.kind === "group") state.socket.emit("groups:join", { groupId: info.id });
        }
      });
      frag.appendChild(el);
    }
    dom.threadList.innerHTML = "";
    dom.threadList.appendChild(frag);
  }

  function setCenterHeaderFromThread(key) {
    const t = state.data.threads[key];
    if (!t) return;
    dom.centerH.textContent = threadName(t);
    dom.centerS.textContent = t.kind === "dm" ? "Direct message" : t.kind === "group" ? "Group chat" : "";
  }

  // Context menu
  function closeCtx() {
    state.ui.ctx.open = false;
    dom.ctx.classList.remove("show");
    dom.ctx.innerHTML = "";
  }
  document.addEventListener("click", () => state.ui.ctx.open && closeCtx());
  window.addEventListener("resize", () => state.ui.ctx.open && closeCtx());
  document.addEventListener("scroll", () => state.ui.ctx.open && closeCtx(), true);

  function openMessageContextMenu(x, y, threadKey, m) {
    closeCtx();

    const mine =
      (m.user?.id && state.session.user?.id && m.user.id === state.session.user.id) ||
      (m.user?.username && state.session.user?.username && m.user.username === state.session.user.username);

    const age = now() - (m.ts || 0);
    const canEdit = mine && age <= 60_000;

    const items = [];
    if (canEdit) {
      items.push({ label: "Edit (1 min)", key: "E", danger: false, onClick: () => (closeCtx(), promptEdit(threadKey, m)) });
      items.push({ label: "Delete (1 min)", key: "D", danger: true, onClick: () => (closeCtx(), promptDelete(threadKey, m)) });
    }
    items.push({ label: "Report", key: "R", danger: true, onClick: () => (closeCtx(), promptReport(threadKey, m)) });

    dom.ctx.innerHTML = items
      .map(
        (it, i) => `
        <div class="ctxItem ${it.danger ? "danger" : ""}" data-i="${i}">
          <div>${esc(it.label)}</div>
          <div class="ctxK">${esc(it.key || "")}</div>
        </div>`
      )
      .join("");

    $$(".ctxItem", dom.ctx).forEach((node) => {
      const i = Number(node.getAttribute("data-i"));
      node.addEventListener("click", () => items[i]?.onClick?.());
    });

    const vw = innerWidth,
      vh = innerHeight;
    const w = 240,
      h = items.length * 44;
    const px = Math.max(10, Math.min(vw - w - 10, x));
    const py = Math.max(10, Math.min(vh - h - 10, y));
    dom.ctx.style.left = px + "px";
    dom.ctx.style.top = py + "px";
    dom.ctx.classList.add("show");

    state.ui.ctx.open = true;
    state.ui.ctx.threadKey = threadKey;
    state.ui.ctx.msgId = m.id;
  }

  // Profile modal
  function openProfile(user) {
    if (!user) return;
    const created = user.createdAt ? new Date(user.createdAt).toLocaleString() : "—";
    const lastSeen = user.lastSeen ? new Date(user.lastSeen).toLocaleString() : "—";
    const bio = user.bio ? esc(user.bio) : `<span style="color:rgba(160,170,195,.75)">No bio.</span>`;
    const lvl = Number(user.level || 1);
    const xp = Number(user.xp || 0);

    openModal(
      user.username || "Profile",
      `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div>
          <div style="font-weight:900;margin-bottom:6px">Bio</div>
          <div style="color:rgba(235,240,255,.9);line-height:1.55">${bio}</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div style="border:1px solid rgba(150,160,190,.14);border-radius:16px;padding:10px;background:rgba(10,12,16,.25)">
            <div style="font-weight:900;margin-bottom:6px">Created</div>
            <div style="color:rgba(160,170,195,.85)">${esc(created)}</div>
          </div>
          <div style="border:1px solid rgba(150,160,190,.14);border-radius:16px;padding:10px;background:rgba(10,12,16,.25)">
            <div style="font-weight:900;margin-bottom:6px">Last seen</div>
            <div style="color:rgba(160,170,195,.85)">${esc(lastSeen)}</div>
          </div>
        </div>

        <div style="border:1px solid rgba(150,160,190,.14);border-radius:16px;padding:10px;background:rgba(10,12,16,.25)">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
            <div style="font-weight:900">Level</div>
            <div style="font-family:ui-monospace;color:rgba(160,170,195,.9)">lvl ${lvl} • xp ${xp}</div>
          </div>
        </div>
      </div>
      `,
      []
    );
  }
  dom.btnUser?.addEventListener("click", () => openProfile(state.session.user));

  // Message UI
  function renderMessages(threadKey) {
    const t = state.data.threads[threadKey];
    if (!t) return;

    setCenterHeaderFromThread(threadKey);
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
      const time = (() => {
        const d = new Date(m.ts || now());
        return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      })();

      const chips = [];
      if (m.kind === "announcement") chips.push(`<span class="chip ann">ANNOUNCEMENT</span>`);
      if (m.pending) chips.push(`<span class="chip">sending</span>`);
      if (m.failed) chips.push(`<span class="chip err">failed</span>`);
      if (m.editedAt) chips.push(`<span class="chip">edited</span>`);

      el.innerHTML = `
        <div class="msgTop">
          <div class="msgUser" style="color:${esc(m.user?.color || "#dfe6ff")}">${uname}</div>
          <div class="msgTime">${esc(time)}</div>
        </div>
        <div class="msgBody">${esc(m.text)}</div>
        <div class="chips">${chips.join("")}</div>
      `;

      // right-click context menu
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        openMessageContextMenu(e.clientX, e.clientY, threadKey, m);
      });

      // click opens profile
      el.addEventListener("click", () => openProfile(m.user));

      frag.appendChild(el);
    }
    dom.centerBody.appendChild(frag);
    dom.centerBody.scrollTop = dom.centerBody.scrollHeight;
  }

  // Online users panel (click to open profile)
  function renderOnlineUsers() {
    const users = Array.isArray(state.ui.onlineUsers) ? state.ui.onlineUsers : [];
    dom.onlineUsers.innerHTML = users
      .slice(0, 120)
      .map((u) => {
        const mode = u.mode || "online";
        const dotClass = mode === "idle" ? "idle" : mode === "dnd" ? "dnd" : mode === "invisible" ? "inv" : "";
        return `
          <div class="uRow" data-u="${esc(u.id || u.username || "")}">
            <span class="dot ${dotClass}"></span>
            <div class="uText">
              <div class="uName">${esc(u.username || "user")}</div>
              <div class="uMeta">${esc(mode)}</div>
            </div>
          </div>
        `;
      })
      .join("");

    $$(".uRow", dom.onlineUsers).forEach((row) => {
      row.addEventListener("click", () => {
        const key = row.getAttribute("data-u");
        const u = users.find((x) => (x.id || x.username) === key);
        if (u) openProfile(u);
      });
    });
  }

  // Login / app show
  function setLoginMsg(msg, err = false) {
    if (!dom.loginMsg) return;
    dom.loginMsg.textContent = msg;
    dom.loginMsg.style.color = err ? "rgba(255,92,122,.95)" : "rgba(160,170,195,.85)";
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
        `<div style="color:rgba(160,170,195,.85)">
          This is a beta build. Features may change and bugs can happen.<br><br>
          You have early access. If the server assigns it, you’ll see an <b>Early Access</b> badge.
        </div>`,
        []
      );
    }
  }

  function showApp() {
    dom.loginWrap.style.display = "none";
    dom.app.style.display = "grid";
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
      await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
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

      // reset UI state
      state.ui.activeThread = "global";
      state.data.threads = {};
      state.data.friends = [];
      state.data.groups = [];
      state.ui.onlineUsers = [];

      showLogin();
    }
  }

  // Friend + Group flows
  async function addFriendFlow() {
    openModal(
      "Add friend",
      `<div style="color:rgba(160,170,195,.85);margin-bottom:10px">Enter a username to add as a friend.</div>
       <input id="friendName" class="input" placeholder="username" />`,
      [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Add",
          kind: "primary",
          onClick: async () => {
            const u = safe($("#friendName")?.value).trim();
            if (!u) return;
            try {
              await api("/api/friends/add", { method: "POST", body: { username: u } });
              toast.show("Friend request added (local).", "ok");
              closeModal();
              await refreshBootstrap();
            } catch (e) {
              toast.show(e.message || "Failed.", "err");
            }
          },
        },
      ]
    );
  }

  async function newGroupFlow() {
    openModal(
      "Create group chat",
      `<div style="color:rgba(160,170,195,.85);margin-bottom:10px">Create a group chat. You become the owner.</div>
       <input id="groupName" class="input" placeholder="Group name" />
       <div style="height:10px"></div>
       <input id="groupCooldown" class="input" placeholder="Cooldown seconds (e.g. 3)" />`,
      [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Create",
          kind: "primary",
          onClick: async () => {
            const name = safe($("#groupName")?.value).trim();
            const cs = Number(safe($("#groupCooldown")?.value).trim() || "3");
            if (!name) return;
            try {
              await api("/api/groups/create", { method: "POST", body: { name, cooldownSeconds: Math.max(0, Math.min(20, cs || 3)) } });
              toast.show("Group created.", "ok");
              closeModal();
              await refreshBootstrap();
            } catch (e) {
              toast.show(e.message || "Failed.", "err");
            }
          },
        },
      ]
    );
  }

  // Messaging actions
  function inCooldown() {
    return state.ui.cooldown.until && now() < state.ui.cooldown.until;
  }

  async function sendMessage() {
    const text = safe(dom.msgInput?.value).trim();
    if (!text) return;

    if (inCooldown()) {
      flashCooldownViolation();
      toast.show("Cooldown active.", "warn", 1200);
      return;
    }

    if (state.ui.sendingLock) return;
    state.ui.sendingLock = true;

    const info = activeThreadInfo();
    const clientId = uid("c");

    // optimistic local msg
    const t = state.data.threads[state.ui.activeThread];
    const localId = uid("m");
    t.messages.push({
      id: localId,
      ts: now(),
      text,
      user: state.session.user,
      pending: true,
    });
    dom.msgInput.value = "";
    renderMessages(state.ui.activeThread);

    const attempt = async (n) => {
      try {
        const r = await api("/api/messages/send", {
          method: "POST",
          body: { scope: info.kind, targetId: info.id, text, clientId },
        });

        if (r?.cooldownUntil) setCooldown(r.cooldownUntil, r.cooldownMs || 0);

        if (r?.ok && r.message) {
          // replace optimistic
          const idx = t.messages.findIndex((x) => x.id === localId);
          if (idx >= 0) t.messages[idx] = r.message;
          renderMessages(state.ui.activeThread);
          state.ui.sendingLock = false;
          return;
        }
        throw new Error(r?.error || "Send failed");
      } catch (e) {
        const status = e?.status || 0;
        const transient = status === 0 || status === 502 || status === 503 || status === 504;
        if (transient && n < 2) {
          await sleep(300 * (n + 1));
          return attempt(n + 1);
        }
        // mark failed
        const idx = t.messages.findIndex((x) => x.id === localId);
        if (idx >= 0) {
          t.messages[idx].pending = false;
          t.messages[idx].failed = true;
        }
        renderMessages(state.ui.activeThread);
        toast.show(e.message || "Message failed.", "err", 1800);
        state.ui.sendingLock = false;
      }
    };

    await attempt(0);
  }

  async function editMessage(messageId, text) {
    const t = state.data.threads[state.ui.activeThread];
    const r = await api("/api/messages/edit", { method: "POST", body: { messageId, text } });
    if (r?.ok && r.message) {
      const idx = t.messages.findIndex((x) => x.id === messageId);
      if (idx >= 0) t.messages[idx] = r.message;
      renderMessages(state.ui.activeThread);
      toast.show("Edited.", "ok", 1200);
    }
  }

  async function deleteMessage(messageId) {
    const t = state.data.threads[state.ui.activeThread];
    const r = await api("/api/messages/delete", { method: "POST", body: { messageId } });
    if (r?.ok) {
      const idx = t.messages.findIndex((x) => x.id === messageId);
      if (idx >= 0) t.messages.splice(idx, 1);
      renderMessages(state.ui.activeThread);
      toast.show("Deleted.", "ok", 1200);
    }
  }

  async function reportMessage(messageId, reason) {
    await api("/api/messages/report", { method: "POST", body: { messageId, reason } });
    toast.show("Reported.", "ok", 1400);
  }

  // Prompt modals
  function promptEdit(threadKey, m) {
    openModal(
      "Edit message",
      `<div style="color:rgba(160,170,195,.85);margin-bottom:10px">Edits allowed within 1 minute.</div>
       <textarea id="editText" class="input" rows="4">${esc(m.text || "")}</textarea>`,
      [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Save",
          kind: "primary",
          onClick: async () => {
            const text = safe($("#editText")?.value).trim();
            if (!text) return;
            try {
              await editMessage(m.id, text);
              closeModal();
            } catch (e) {
              toast.show(e.message || "Edit failed.", "err");
            }
          },
        },
      ]
    );
  }

  function promptDelete(threadKey, m) {
    openModal(
      "Delete message",
      `<div style="color:rgba(160,170,195,.85)">Delete this message? (1 minute window)</div>`,
      [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Delete",
          kind: "danger",
          onClick: async () => {
            try {
              await deleteMessage(m.id);
              closeModal();
            } catch (e) {
              toast.show(e.message || "Delete failed.", "err");
            }
          },
        },
      ]
    );
  }

  function promptReport(threadKey, m) {
    openModal(
      "Report message",
      `<div style="color:rgba(160,170,195,.85);margin-bottom:10px">This sends a report to moderation.</div>
       <input id="reportReason" class="input" placeholder="Reason (optional)" />`,
      [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Report",
          kind: "danger",
          onClick: async () => {
            const reason = safe($("#reportReason")?.value).trim();
            try {
              await reportMessage(m.id, reason);
              closeModal();
            } catch (e) {
              toast.show(e.message || "Report failed.", "err");
            }
          },
        },
      ]
    );
  }

  // Settings modal
  function openSettings() {
    const s = state.ui.settings;
    openModal(
      "Settings",
      `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="border:1px solid rgba(150,160,190,.14);border-radius:16px;padding:10px;background:rgba(10,12,16,.25)">
          <div style="font-weight:900;margin-bottom:8px">Cursor</div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
            <button id="setCursorOn" class="btn mini ${s.cursor.enabled ? "primary" : ""}">enabled</button>
            <button id="setCursorOff" class="btn mini ${!s.cursor.enabled ? "primary" : ""}">disabled</button>
            <button id="setCursorDyn" class="btn mini ${s.cursor.dynamic ? "primary" : ""}">dynamic</button>
            <button id="setCursorStatic" class="btn mini ${!s.cursor.dynamic ? "primary" : ""}">static</button>
          </div>
        </div>
      </div>
      `,
      []
    );

    $("#setCursorOn")?.addEventListener("click", () => {
      state.ui.settings.cursor.enabled = true;
      localSet("tk_settings", state.ui.settings);
      applyCursorMode();
      closeModal();
      openSettings();
    });
    $("#setCursorOff")?.addEventListener("click", () => {
      state.ui.settings.cursor.enabled = false;
      localSet("tk_settings", state.ui.settings);
      applyCursorMode();
      closeModal();
      openSettings();
    });
    $("#setCursorDyn")?.addEventListener("click", () => {
      state.ui.settings.cursor.dynamic = true;
      localSet("tk_settings", state.ui.settings);
      closeModal();
      openSettings();
    });
    $("#setCursorStatic")?.addEventListener("click", () => {
      state.ui.settings.cursor.dynamic = false;
      localSet("tk_settings", state.ui.settings);
      closeModal();
      openSettings();
    });
  }

  // Bootstrap / refresh
  async function refreshBootstrap() {
    const data = await api("/api/state/bootstrap", { method: "GET" });
    if (!data?.ok) throw new Error(data?.error || "bootstrap failed");

    // set "me"
    state.data.me = data.me || state.session.user;

    // ensure global thread
    ensureThread("global", { kind: "global", id: null, name: "Global" }).messages = Array.isArray(data.global?.messages) ? data.global.messages : [];

    // friends -> DM threads
    state.data.friends = Array.isArray(data.friends) ? data.friends : [];
    for (const f of state.data.friends) {
      const key = `dm:${f.id}`;
      const th = ensureThread(key, { kind: "dm", id: f.id, name: f.username || "user" });
      th.messages = Array.isArray(f.messages) ? f.messages : (Array.isArray(data.dms?.[f.id]) ? data.dms[f.id] : th.messages || []);
    }

    // groups
    state.data.groups = Array.isArray(data.groups) ? data.groups : [];
    for (const g of state.data.groups) {
      const key = `group:${g.id}`;
      const th = ensureThread(key, { kind: "group", id: g.id, name: g.name || "group" });
      th.messages = Array.isArray(g.messages) ? g.messages : (Array.isArray(data.groupThreads?.[g.id]) ? data.groupThreads[g.id] : th.messages || []);
    }

    // online users
    state.ui.onlineUsers = Array.isArray(data.onlineUsers) ? data.onlineUsers : [];

    // links
    if (dom.linkGithub && data.links?.github) dom.linkGithub.href = data.links.github;
    if (dom.linkKofi && data.links?.kofi) dom.linkKofi.href = data.links.kofi;

    // if activeThread disappeared, fallback to global
    if (!state.data.threads[state.ui.activeThread]) state.ui.activeThread = "global";

    renderThreadList();
    renderMessages(state.ui.activeThread);
    renderOnlineUsers();
  }

  // Socket
  function initSocket() {
    if (!window.io) return;

    try {
      state.socket?.removeAllListeners?.();
      state.socket?.disconnect?.();
    } catch {}

    const socket = io({
      transports: ["websocket", "polling"],
      auth: { token: state.session.token },
    });
    state.socket = socket;

    socket.on("connect", () => {
      socket.emit("auth", { token: state.session.token });
    });

    socket.on("users:online", (payload) => {
      const users = payload?.users;
      if (Array.isArray(users)) {
        state.ui.onlineUsers = users;
        renderOnlineUsers();
      }
    });

    socket.on("presence:update", (p) => {
      if (p?.me?.mode) setPresenceUi(p.me.mode);
    });

    socket.on("message:new", (m) => {
      if (!m?.id) return;
      const key =
        m.scope === "global"
          ? "global"
          : m.scope === "dm"
          ? `dm:${m.targetId}`
          : m.scope === "group"
          ? `group:${m.targetId}`
          : null;
      if (!key) return;

      ensureThread(key, { kind: m.scope, id: m.targetId, name: "" });
      const t = state.data.threads[key];

      // de-dupe by id
      if (t.messages.some((x) => x.id === m.id)) return;

      t.messages.push(m);
      t.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));

      renderThreadList();
      if (state.ui.activeThread === key) renderMessages(key);
    });

    socket.on("message:edit", (m) => {
      const key =
        m.scope === "global"
          ? "global"
          : m.scope === "dm"
          ? `dm:${m.targetId}`
          : m.scope === "group"
          ? `group:${m.targetId}`
          : null;
      if (!key) return;
      const t = state.data.threads[key];
      if (!t) return;
      const idx = t.messages.findIndex((x) => x.id === m.id);
      if (idx >= 0) t.messages[idx] = m;
      if (state.ui.activeThread === key) renderMessages(key);
    });

    socket.on("message:delete", (p) => {
      const key =
        p.scope === "global"
          ? "global"
          : p.scope === "dm"
          ? `dm:${p.targetId}`
          : p.scope === "group"
          ? `group:${p.targetId}`
          : null;
      if (!key) return;
      const t = state.data.threads[key];
      if (!t) return;
      const idx = t.messages.findIndex((x) => x.id === p.messageId);
      if (idx >= 0) t.messages.splice(idx, 1);
      if (state.ui.activeThread === key) renderMessages(key);
    });

    socket.on("typing:update", (p) => {
      if (!p) return;
      const info = activeThreadInfo();
      const match = (p.scope === info.kind) && (String(p.targetId || "") === String(info.id || ""));
      if (!match) return;

      const names = Array.isArray(p.users) ? p.users.map((u) => u.username).filter(Boolean) : [];
      const filtered = names.filter((n) => n !== state.session.user?.username);
      dom.typingText.textContent = filtered.length ? `${filtered.slice(0, 3).join(", ")} typing…` : "";
      clearTimeout(state.ui.typingTimer);
      state.ui.typingTimer = setTimeout(() => (dom.typingText.textContent = ""), 2400);
    });

    socket.on("session:revoked", () => {
      openModal("Session ended", `<div style="color:rgba(160,170,195,.85)">Signed in elsewhere.</div>`, [
        { label: "OK", kind: "danger", onClick: async () => { closeModal(); await doLogout(); } },
      ]);
    });
  }

  // Presence setters
  async function setPresence(mode) {
    try {
      setPresenceUi(mode);
      if (state.socket) state.socket.emit("presence:set", { mode });
      await api("/api/presence", { method: "POST", body: { mode } }).catch(() => {});
    } catch {}
  }

  // Typing emission
  let typingDebounce = null;
  function emitTyping(typing) {
    if (!state.socket) return;
    const info = activeThreadInfo();
    if (info.kind !== "dm" && info.kind !== "group" && info.kind !== "global") return;
    state.socket.emit("typing", { scope: info.kind, targetId: info.id, typing: !!typing });
  }

  // After auth boot
  async function afterAuth() {
    showApp();
    showLoading("Loading…", "bootstrap");
    await sleep(80);

    try {
      await refreshBootstrap();
    } catch (e) {
      toast.show(e.message || "Bootstrap failed.", "err", 2000);
      console.error(e);
    }

    initSocket();
    hideLoading();
  }

  // UI event wiring
  dom.btnLogin?.addEventListener("click", () => doLogin(dom.loginUser.value.trim(), dom.loginPass.value));
  dom.btnGuest?.addEventListener("click", () => doGuest());
  dom.loginPass?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") dom.btnLogin.click();
  });

  dom.btnLogout?.addEventListener("click", doLogout);
  dom.searchThreads?.addEventListener("input", renderThreadList);

  dom.btnSend?.addEventListener("click", sendMessage);
  dom.msgInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else {
      // typing ping
      clearTimeout(typingDebounce);
      emitTyping(true);
      typingDebounce = setTimeout(() => emitTyping(false), 900);
    }
  });

  dom.btnAddFriend?.addEventListener("click", addFriendFlow);
  dom.btnNewGroup?.addEventListener("click", newGroupFlow);

  dom.btnPresenceOnline?.addEventListener("click", () => setPresence("online"));
  dom.btnPresenceIdle?.addEventListener("click", () => setPresence("idle"));
  dom.btnPresenceDnd?.addEventListener("click", () => setPresence("dnd"));
  dom.btnPresenceInv?.addEventListener("click", () => setPresence("invisible"));

  dom.btnSettings?.addEventListener("click", openSettings);

  // Hotkeys for context menu items (optional)
  document.addEventListener("keydown", (e) => {
    if (!state.ui.ctx.open) return;
    const key = e.key.toLowerCase();
    const msgId = state.ui.ctx.msgId;
    if (!msgId) return;

    const t = state.data.threads[state.ui.activeThread];
    const m = t?.messages?.find((x) => x.id === msgId);
    if (!m) return;

    if (key === "e") promptEdit(state.ui.activeThread, m);
    if (key === "d") promptDelete(state.ui.activeThread, m);
    if (key === "r") promptReport(state.ui.activeThread, m);
  });

  // Initial load: if token exists, try boot; else show login
  (async () => {
    try {
      if (state.session.token) {
        showApp();
        showLoading("Restoring session…", "session");
        await afterAuth();
      } else {
        showLogin();
      }
    } catch (e) {
      console.error(e);
      showLogin();
    }
  })();

  // Expose actions to context prompts
  window.__TONKOTSU_ACTIONS__ = { editMessage, deleteMessage, reportMessage };
})();
