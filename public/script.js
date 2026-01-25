/* public/script.js
   tonkotsu.online — compact black client

   Key fixes in this version:
   - Prevent script double-load (window.__TONKOTSU_CLIENT_LOADED guard)
   - Prevent double-send with clientId de-dupe and send lock
   - Strong custom cursor: forces cursor:none on ALL elements while enabled
   - Cooldown bar + red shake/flash when user tries to send during cooldown
   - Online users list in right panel (no avatars)
   - First-join modal (single close control; early access badge mention)
   - Toast system
   - Message fail handling + retry/backoff on transient errors

   NOTE: Some features require server support:
   - users:online should include users list with presence
   - idempotency on /api/messages/send using clientId
   - presence uniqueness per user (avoid counting multiple tabs)
*/

(() => {
  "use strict";

  // -----------------------------
  // HARD GUARD: prevent double-load
  // -----------------------------
  if (window.__TONKOTSU_CLIENT_LOADED) {
    console.warn("[tonkotsu] script.js loaded twice; ignoring second load.");
    return;
  }
  window.__TONKOTSU_CLIENT_LOADED = true;

  // -----------------------------
  // Utilities
  // -----------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const now = () => Date.now();
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const safeText = (s) => (typeof s === "string" ? s : "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function escapeHtml(str) {
    return safeText(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function fmtTime(ts) {
    try {
      const d = new Date(ts);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    } catch {
      return "--:--";
    }
  }

  function uid(prefix = "id") {
    return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
  }

  function localGet(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  }

  function localSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  async function api(path, { method = "GET", body = null } = {}) {
    const token = state.session.token;
    const headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const res = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : null,
    });

    const ct = res.headers.get("content-type") || "";
    const isJson = ct.includes("application/json");
    const data = isJson ? await res.json().catch(() => ({})) : await res.text().catch(() => "");
    if (!res.ok) {
      const msg = (data && data.error) || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // -----------------------------
  // Toasts
  // -----------------------------
  const toast = (() => {
    let wrap = null;

    function ensureWrap() {
      if (wrap) return wrap;
      wrap = document.createElement("div");
      wrap.id = "toasts";
      wrap.style.position = "fixed";
      wrap.style.right = "16px";
      wrap.style.bottom = "16px";
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.gap = "10px";
      wrap.style.zIndex = "9999";
      document.body.appendChild(wrap);
      return wrap;
    }

    function show(message, kind = "info", ttl = 2400) {
      ensureWrap();
      const t = document.createElement("div");
      t.className = `toast ${kind}`;
      t.style.padding = "10px 12px";
      t.style.borderRadius = "14px";
      t.style.border = "1px solid rgba(130,140,170,.28)";
      t.style.background = "rgba(10,12,16,.92)";
      t.style.color = "rgba(235,240,255,.92)";
      t.style.fontSize = "13px";
      t.style.maxWidth = "320px";
      t.style.boxShadow = "0 10px 30px rgba(0,0,0,.45)";
      t.style.backdropFilter = "blur(10px)";
      t.style.transform = "translateY(8px)";
      t.style.opacity = "0";

      if (kind === "err") t.style.borderColor = "rgba(255,92,122,.35)";
      if (kind === "ok") t.style.borderColor = "rgba(120,255,190,.25)";
      if (kind === "warn") t.style.borderColor = "rgba(255,210,120,.25)";

      t.innerHTML = `<div>${escapeHtml(message)}</div>`;
      wrap.appendChild(t);

      requestAnimationFrame(() => {
        t.style.transition = "all 180ms ease";
        t.style.transform = "translateY(0)";
        t.style.opacity = "1";
      });

      const kill = () => {
        t.style.transition = "all 180ms ease";
        t.style.transform = "translateY(8px)";
        t.style.opacity = "0";
        setTimeout(() => t.remove(), 210);
      };

      const id = setTimeout(kill, ttl);
      t.addEventListener("click", () => {
        clearTimeout(id);
        kill();
      });
    }

    return { show };
  })();

  // -----------------------------
  // State
  // -----------------------------
  const state = {
    session: {
      token: localGet("tk_token", null),
      user: localGet("tk_user", null),
    },
    ui: {
      // future refactor: one messaging sidebar; for now keep a "scope"
      scope: "global", // global | dm | group
      targetId: null,
      skeleton: true,
      bootstrapped: false,
      sending: false,
      sendDedupe: new Map(), // clientId -> ts
      cooldown: { until: 0 },
      context: { open: false, msgId: null },
      typing: { lastUpdateAt: 0 },
      lastRead: { global: null, dm: {}, group: {} },
      onlineUsers: [], // [{id,username,mode}]
    },
    data: {
      global: { messages: [], cursor: null, hasMore: true },
      dms: { threads: {}, friends: [] },
      groups: { list: [], threads: {} },
      whatsNew: [],
      onlineCount: 0,
    },
    settings: {
      cursor: { enabled: true, size: 1.4, dynamic: true },
      sound: { enabled: true, volume: 0.35 },
      filters: { globalProfanityBlock: false, profanityLevel: 1, adultBlock: true },
      presenceMode: "online",
    },
    socket: null,
  };

  // purge old dedupe entries
  setInterval(() => {
    const cutoff = now() - 60_000;
    for (const [k, ts] of state.ui.sendDedupe.entries()) {
      if (ts < cutoff) state.ui.sendDedupe.delete(k);
    }
  }, 15_000);

  // -----------------------------
  // DOM cache
  // -----------------------------
  const dom = {
    loginWrap: $("#loginWrap"),
    loginUser: $("#loginUser"),
    loginPass: $("#loginPass"),
    loginMsg: $("#loginMsg"),
    btnLogin: $("#btnLogin"),
    btnGuest: $("#btnGuest"),

    // optional login "what's new" container (next file will add)
    loginWhatsNew: $("#loginWhatsNew"),

    loading: $("#loading"),
    loadMsg: $("#loadMsg"),
    loadTag: $("#loadTag"),

    app: $("#app"),

    subtitle: $("#subtitle"),
    btnUser: $("#btnUser"),
    btnLogout: $("#btnLogout"),

    presencePill: $("#presencePill"),
    presenceDot: $("#presenceDot"),
    presenceLabel: $("#presenceLabel"),
    onlineCount: $("#onlineCount"),

    // messaging view
    centerH: $("#centerH"),
    centerS: $("#centerS"),
    centerBody: $("#centerBody"),
    btnJumpLastRead: $("#btnJumpLastRead"),
    btnRefresh: $("#btnRefresh"),

    composer: $("#composer"),
    msgInput: $("#msgInput"),
    btnSend: $("#btnSend"),
    typingText: $("#typingText"),
    cooldownText: $("#cooldownText"),

    // NEW (optional): cooldown progress bar element
    cooldownBar: $("#cooldownBar"),

    rightLabel: $("#rightLabel"),
    rightBody: $("#rightBody"),
    btnRightAction: $("#btnRightAction"),

    // modal
    backdrop: $("#backdrop"),
    modalTitle: $("#modalTitle"),
    modalBody: $("#modalBody"),
    modalFoot: $("#modalFoot"),
    modalClose: $("#modalClose"),

    // context menu
    ctx: $("#ctx"),

    // cursor
    cursor: $("#cursor"),
    trail: $("#trail"),
  };

  // -----------------------------
  // Modal helpers (single close control)
  // -----------------------------
  function closeModal() {
    dom.backdrop?.classList.remove("show");
    if (dom.modalTitle) dom.modalTitle.textContent = "";
    if (dom.modalBody) dom.modalBody.innerHTML = "";
    if (dom.modalFoot) dom.modalFoot.innerHTML = ""; // no footer close buttons by default
  }

  function openModal(title, bodyHtml, footButtons = []) {
    if (dom.modalTitle) dom.modalTitle.textContent = title;
    if (dom.modalBody) dom.modalBody.innerHTML = bodyHtml;
    if (dom.modalFoot) dom.modalFoot.innerHTML = "";

    // Only render footer buttons if explicitly needed (prevents “two close buttons” issue)
    for (const b of footButtons) {
      const btn = document.createElement("button");
      btn.className = `btn ${b.kind || ""}`.trim();
      btn.textContent = b.label;
      btn.onclick = () => b.onClick && b.onClick();
      dom.modalFoot.appendChild(btn);
    }

    dom.backdrop?.classList.add("show");
  }

  dom.modalClose?.addEventListener("click", closeModal);
  dom.backdrop?.addEventListener("click", (e) => {
    if (e.target === dom.backdrop) closeModal();
  });

  // -----------------------------
  // Subtitle requirement
  // -----------------------------
  function renderTop() {
    if (dom.subtitle) dom.subtitle.innerHTML = `tonkotsu.online <span class="beta">beta</span>`;
    if (dom.btnUser) dom.btnUser.textContent = state.session.user?.username || "user";
    setPresenceUi(state.settings.presenceMode || "online");
  }

  // -----------------------------
  // Presence UI
  // -----------------------------
  function setPresenceUi(mode) {
    if (!dom.presenceDot || !dom.presenceLabel) return;
    dom.presenceDot.classList.remove("idle", "dnd", "inv");
    if (mode === "idle") dom.presenceDot.classList.add("idle");
    else if (mode === "dnd") dom.presenceDot.classList.add("dnd");
    else if (mode === "invisible") dom.presenceDot.classList.add("inv");
    dom.presenceLabel.textContent = mode || "online";
  }

  async function setPresence(mode) {
    state.settings.presenceMode = mode;
    localSet("tk_settings", state.settings);
    setPresenceUi(mode);
    if (state.socket) state.socket.emit("presence:set", { mode });
  }

  // -----------------------------
  // Cursor: force-hide native cursor everywhere
  // -----------------------------
  function applyCursorMode() {
    const enabled = !!state.settings.cursor.enabled;

    // If enabled, enforce cursor:none universally
    if (enabled) {
      document.documentElement.setAttribute("data-cursor", "custom");
      document.documentElement.style.cursor = "none";
      document.body.style.cursor = "none";
      // force hide on everything (important because buttons often set cursor:pointer)
      if (!document.getElementById("__cursor_force_style")) {
        const st = document.createElement("style");
        st.id = "__cursor_force_style";
        st.textContent = `
          html[data-cursor="custom"], html[data-cursor="custom"] * { cursor: none !important; }
          #cursor, #trail { pointer-events: none !important; }
        `;
        document.head.appendChild(st);
      }
      if (dom.cursor) dom.cursor.style.display = "block";
      if (dom.trail) dom.trail.style.display = "block";
    } else {
      document.documentElement.removeAttribute("data-cursor");
      document.documentElement.style.cursor = "";
      document.body.style.cursor = "";
      if (dom.cursor) dom.cursor.style.display = "none";
      if (dom.trail) dom.trail.style.display = "none";
    }
  }

  // watchdog prevents flicker
  setInterval(() => {
    if (!state.settings.cursor.enabled) return;
    if (document.documentElement.style.cursor !== "none") document.documentElement.style.cursor = "none";
    if (document.body.style.cursor !== "none") document.body.style.cursor = "none";
    if (dom.cursor && dom.cursor.style.display !== "block") dom.cursor.style.display = "block";
    if (dom.trail && dom.trail.style.display !== "block") dom.trail.style.display = "block";
  }, 350);

  // dynamic cursor motion
  const cursorState = {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    tx: window.innerWidth / 2,
    ty: window.innerHeight / 2,
    vx: 0,
    vy: 0,
    over: false,
    down: false,
    lastMove: now(),
  };

  document.addEventListener("mousemove", (e) => {
    cursorState.tx = e.clientX;
    cursorState.ty = e.clientY;
    cursorState.lastMove = now();
  });

  document.addEventListener("mousedown", () => (cursorState.down = true));
  document.addEventListener("mouseup", () => (cursorState.down = false));

  // detect “interactive hover” for dynamics
  document.addEventListener(
    "mouseover",
    (e) => {
      const t = e.target;
      cursorState.over = !!(t && (t.closest("button") || t.closest("a") || t.closest("input") || t.closest("[role='button']") || t.closest(".mini")));
    },
    true
  );

  function cursorTick() {
    if (!state.settings.cursor.enabled) {
      requestAnimationFrame(cursorTick);
      return;
    }

    const dynamic = !!state.settings.cursor.dynamic;
    const baseScale = clamp(state.settings.cursor.size || 1.4, 0.9, 2.0);

    const dx = cursorState.tx - cursorState.x;
    const dy = cursorState.ty - cursorState.y;

    cursorState.vx = (cursorState.vx + dx * 0.16) * 0.64;
    cursorState.vy = (cursorState.vy + dy * 0.16) * 0.64;

    cursorState.x += cursorState.vx;
    cursorState.y += cursorState.vy;

    let scale = baseScale;
    if (dynamic) {
      // stronger dynamics than before
      if (cursorState.over) scale *= 1.25;
      if (cursorState.down) scale *= 0.82;

      const idle = Math.min(1, (now() - cursorState.lastMove) / 2200);
      scale *= 1 + idle * 0.08 * Math.sin(now() / 360);
    }

    if (dom.cursor) {
      dom.cursor.style.transform = `translate(${cursorState.x}px, ${cursorState.y}px) translate(-50%,-50%) scale(${scale})`;
    }
    if (dom.trail) {
      const tx = cursorState.x - cursorState.vx * 2.2;
      const ty = cursorState.y - cursorState.vy * 2.2;
      const speed = Math.min(1, Math.hypot(cursorState.vx, cursorState.vy) / 26);
      const op = dynamic ? 0.14 + speed * 0.48 : 0.22;
      dom.trail.style.transform = `translate(${tx}px, ${ty}px) translate(-50%,-50%)`;
      dom.trail.style.opacity = String(op);
    }

    requestAnimationFrame(cursorTick);
  }
  requestAnimationFrame(cursorTick);

  // -----------------------------
  // Cooldown bar + shake/flash
  // -----------------------------
  function setCooldown(untilTs) {
    state.ui.cooldown.until = untilTs || 0;
    updateCooldownUi(true);
  }

  function flashCooldownViolation() {
    // shake + red flash
    const el = dom.cooldownBar || dom.cooldownText || dom.composer;
    if (!el) return;

    el.classList.remove("cd-shake", "cd-red");
    // force reflow
    void el.offsetWidth;
    el.classList.add("cd-shake", "cd-red");

    // fade red out
    setTimeout(() => el.classList.remove("cd-red"), 520);
    setTimeout(() => el.classList.remove("cd-shake"), 620);
  }

  function updateCooldownUi(force = false) {
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

    const leftMs = until - now();
    const sec = Math.ceil(leftMs / 1000);

    if (dom.cooldownText) dom.cooldownText.textContent = `cooldown: ${sec}s`;

    // progress bar: assume server provides cooldown duration sometimes; fallback 5s
    const durationMs = clamp(Number(localGet("tk_lastCooldownMs", 5000)), 1000, 60000);
    const start = until - durationMs;
    const pct = clamp(((now() - start) / durationMs) * 100, 0, 100);

    if (dom.cooldownBar) {
      dom.cooldownBar.style.opacity = "1";
      dom.cooldownBar.style.width = `${pct}%`;
    }

    if (force) {
      // store last cooldown duration estimate
      localSet("tk_lastCooldownMs", durationMs);
    }
  }

  setInterval(updateCooldownUi, 120);

  // -----------------------------
  // Message rendering
  // -----------------------------
  function getThread(scope, targetId) {
    if (scope === "global") return state.data.global;
    if (scope === "dm") return state.data.dms.threads[targetId] || null;
    if (scope === "group") return state.data.groups.threads[targetId] || null;
    return null;
  }

  function renderMessageNode(m, scope, targetId) {
    const el = document.createElement("div");
    el.className = "msg";
    el.setAttribute("data-id", m.id);
    el.setAttribute("data-ts", String(m.ts || 0));

    // no avatars anywhere
    const uname = escapeHtml(m.user?.username || "user");
    const color = escapeHtml(m.user?.color || "#9aa3b7");
    const time = fmtTime(m.ts || now());
    const txt = escapeHtml(safeText(m.text));

    const pending = m.pending ? `<span class="chip">sending</span>` : "";
    const failed = m.failed ? `<span class="chip err">failed</span>` : "";
    const ann = m.kind === "announcement" ? `<span class="chip ann">ANNOUNCEMENT</span>` : "";

    el.innerHTML = `
      <div class="msg-main">
        <div class="msg-top">
          <div class="msg-user">
            <span class="name" style="color:${color}">${uname}</span>
          </div>
          <div class="time">${escapeHtml(time)}</div>
        </div>
        <div class="body">${txt}</div>
        <div class="meta">${ann}${pending}${failed}</div>
      </div>
    `;

    return el;
  }

  function renderThread(scope, targetId) {
    state.ui.scope = scope;
    state.ui.targetId = targetId;

    if (!dom.centerBody) return;
    dom.centerBody.innerHTML = "";

    const th = getThread(scope, targetId);
    const msgs = th?.messages || [];
    if (!msgs.length) {
      dom.centerBody.innerHTML = `<div class="card"><h3>No messages</h3><p>Send the first message.</p></div>`;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const m of msgs) frag.appendChild(renderMessageNode(m, scope, targetId));
    dom.centerBody.appendChild(frag);

    setTimeout(() => {
      dom.centerBody.scrollTop = dom.centerBody.scrollHeight;
    }, 0);
  }

  function ingestMessage(m) {
    if (!m || !m.scope) return;

    if (m.scope === "global") {
      state.data.global.messages.push(m);
      state.data.global.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (state.ui.scope === "global") renderThread("global", null);
      return;
    }
    if (m.scope === "dm") {
      const peerId = m.targetId || m.peerId;
      if (!peerId) return;
      if (!state.data.dms.threads[peerId]) state.data.dms.threads[peerId] = { peer: { id: peerId, username: "User" }, messages: [], cursor: null, hasMore: true };
      const th = state.data.dms.threads[peerId];
      th.messages.push(m);
      th.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (state.ui.scope === "dm" && state.ui.targetId === peerId) renderThread("dm", peerId);
      return;
    }
    if (m.scope === "group") {
      const gid = m.targetId || m.groupId;
      if (!gid) return;
      if (!state.data.groups.threads[gid]) state.data.groups.threads[gid] = { info: { id: gid, name: "Group Chat" }, messages: [], cursor: null, hasMore: true };
      const th = state.data.groups.threads[gid];
      th.messages.push(m);
      th.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (state.ui.scope === "group" && state.ui.targetId === gid) renderThread("group", gid);
    }
  }

  function replaceLocalMessage(localId, realMessage) {
    const th = getThread(realMessage.scope, realMessage.targetId || null);
    if (!th?.messages) return;
    const idx = th.messages.findIndex((x) => x.id === localId);
    if (idx >= 0) th.messages[idx] = realMessage;
    renderThread(state.ui.scope, state.ui.targetId);
  }

  function markLocalMessageFailed(localId, error) {
    const th = getThread(state.ui.scope, state.ui.targetId);
    if (!th?.messages) return;
    const idx = th.messages.findIndex((x) => x.id === localId);
    if (idx >= 0) {
      th.messages[idx].failed = true;
      th.messages[idx].pending = false;
      th.messages[idx].error = error;
    }
    renderThread(state.ui.scope, state.ui.targetId);
  }

  // -----------------------------
  // Sending (fix double-send + retry)
  // -----------------------------
  function currentScopeForSend() {
    return { scope: state.ui.scope, targetId: state.ui.targetId };
  }

  function inCooldown() {
    return state.ui.cooldown.until && now() < state.ui.cooldown.until;
  }

  async function sendMessage(text) {
    const { scope, targetId } = currentScopeForSend();
    const trimmed = safeText(text).trim();
    if (!trimmed) return;

    if (inCooldown()) {
      flashCooldownViolation();
      toast.show("Cooldown active.", "warn", 1200);
      return;
    }

    // send lock prevents rapid double-click + Enter
    if (state.ui.sending) return;
    state.ui.sending = true;

    // idempotency clientId
    const clientId = uid("c");
    state.ui.sendDedupe.set(clientId, now());

    // optimistic
    const localId = uid("m");
    const m = {
      id: localId,
      ts: now(),
      text: trimmed,
      scope,
      targetId,
      user: state.session.user || { username: "me" },
      pending: true,
    };
    ingestMessage(m);

    if (dom.msgInput) dom.msgInput.value = "";

    const attemptSend = async (attempt) => {
      try {
        const resp = await api("/api/messages/send", {
          method: "POST",
          body: { scope, targetId, text: trimmed, clientId },
        });

        if (resp?.cooldownUntil) {
          // estimate duration from server if provided
          if (resp.cooldownMs) localSet("tk_lastCooldownMs", resp.cooldownMs);
          setCooldown(resp.cooldownUntil);
        }

        if (resp?.ok && resp.message) {
          replaceLocalMessage(localId, resp.message);
          state.ui.sending = false;
          return true;
        }

        throw new Error(resp?.error || "Send failed");
      } catch (e) {
        const status = e?.status || 0;
        const transient = status === 0 || status === 502 || status === 503 || status === 504;

        if (transient && attempt < 2) {
          // backoff
          await sleep(300 * (attempt + 1));
          return attemptSend(attempt + 1);
        }

        markLocalMessageFailed(localId, e.message || "Send failed");
        toast.show("Message failed to send.", "err", 1800);
        state.ui.sending = false;
        return false;
      }
    };

    await attemptSend(0);
  }

  // -----------------------------
  // Online users list (right panel)
  // -----------------------------
  function renderOnlineUsersPanel() {
    if (!dom.rightBody || !dom.rightLabel) return;

    dom.rightLabel.textContent = "Online users";
    const users = state.ui.onlineUsers || [];

    const rows = users
      .slice(0, 80)
      .map((u) => {
        const mode = u.mode || "online";
        const dotClass = mode === "idle" ? "idle" : mode === "dnd" ? "dnd" : mode === "invisible" ? "inv" : "on";
        return `
          <div class="mini">
            <span class="pDot ${dotClass}"></span>
            <div class="left">
              <div class="t">${escapeHtml(u.username || "user")}</div>
              <div class="d">${escapeHtml(mode)}</div>
            </div>
          </div>
        `;
      })
      .join("");

    dom.rightBody.innerHTML = `
      <div class="card">
        <h3>Online users</h3>
        <p>${escapeHtml(String(users.length))} online</p>
      </div>
      <div class="card">
        <div class="list">
          ${rows || `<div class="small">No users online.</div>`}
        </div>
      </div>
    `;
  }

  // -----------------------------
  // Login / boot
  // -----------------------------
  function setLoginMessage(msg, isError = false) {
    if (!dom.loginMsg) return;
    dom.loginMsg.textContent = msg;
    dom.loginMsg.style.color = isError ? "rgba(255,92,122,.95)" : "";
  }

  function showLoading(msg = "Loading…", tag = "boot") {
    if (dom.loadMsg) dom.loadMsg.textContent = msg;
    if (dom.loadTag) dom.loadTag.textContent = tag;
    dom.loading?.classList.add("show");
  }

  function hideLoading() {
    dom.loading?.classList.remove("show");
  }

  function showLogin() {
    dom.app && (dom.app.style.display = "none");
    dom.loginWrap && (dom.loginWrap.style.display = "flex");
    hideLoading();
    setLoginMessage("Sign in or use Guest.");
    applyCursorMode();

    // first-join popup (only once per device)
    const first = localGet("tk_firstJoinShown", false);
    if (!first) {
      localSet("tk_firstJoinShown", true);
      openModal(
        "Welcome to tonkotsu.online (beta)",
        `
          <div class="small">
            This is a beta build. Features may change, and there may be bugs.
            You currently have early access — you may see an <b>Early Access</b> badge if the server assigns it.
          </div>
          <div class="small" style="margin-top:10px">
            If anything breaks, check the console and server logs first.
          </div>
        `,
        [] // no footer close button; use the X only
      );
    }
  }

  function showApp() {
    dom.loginWrap && (dom.loginWrap.style.display = "none");
    dom.app && (dom.app.style.display = "flex");
    applyCursorMode();
  }

  async function doLogin(username, password) {
    setLoginMessage("Signing in…");
    try {
      const data = await api("/api/auth/login", { method: "POST", body: { username, password } });
      if (!data?.ok || !data.token) throw new Error(data?.error || "Login failed");
      state.session.token = data.token;
      state.session.user = data.user;
      localSet("tk_token", data.token);
      localSet("tk_user", data.user);
      await afterAuthBoot();
    } catch (e) {
      setLoginMessage(e.message || "Login failed", true);
      toast.show("Sign-in failed.", "err");
    }
  }

  async function doGuest() {
    setLoginMessage("Starting guest…");
    try {
      const data = await api("/api/auth/guest", { method: "POST", body: {} });
      if (!data?.ok || !data.token) throw new Error(data?.error || "Guest failed");
      state.session.token = data.token;
      state.session.user = data.user;
      localSet("tk_token", data.token);
      localSet("tk_user", data.user);
      await afterAuthBoot();
    } catch (e) {
      setLoginMessage(e.message || "Guest failed", true);
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

      // reset
      state.ui.scope = "global";
      state.ui.targetId = null;
      state.ui.skeleton = true;
      state.ui.bootstrapped = false;
      state.ui.onlineUsers = [];
      state.data.global.messages = [];
      state.data.groups.list = [];
      state.data.groups.threads = {};
      state.data.dms.threads = {};
      state.data.dms.friends = [];

      showLogin();
    }
  }

  async function bootstrap() {
    state.ui.skeleton = true;
    showLoading("Loading…", "state");

    const data = await api("/api/state/bootstrap", { method: "GET" });
    if (!data?.ok) throw new Error(data?.error || "bootstrap failed");

    state.data.global.messages = Array.isArray(data.global?.messages) ? data.global.messages : [];
    state.data.groups.list = Array.isArray(data.groups) ? data.groups : [];
    state.data.dms.friends = Array.isArray(data.friends) ? data.friends : [];

    // random color assignment fallback (server should persist a color)
    const me = state.session.user || {};
    if (!me.color) {
      me.color = pickColor(me.username || "user");
      state.session.user = me;
      localSet("tk_user", me);
    }

      state.ui.onlineUsers = Array.isArray(data.onlineUsers) ? data.onlineUsers : [];
    state.data.onlineCount =
      typeof data.onlineCount === "number"
        ? data.onlineCount
        : (state.ui.onlineUsers?.length || 0);

    // Build DM/group thread maps if server provides them (optional)
    const dmThreads = Array.isArray(data.dms) ? data.dms : [];
    state.data.dms.threads = {};
    for (const th of dmThreads) {
      if (!th?.peer?.id) continue;
      state.data.dms.threads[th.peer.id] = {
        peer: th.peer,
        messages: Array.isArray(th.messages) ? th.messages : [],
        cursor: th.cursor ?? null,
        hasMore: th.hasMore ?? true,
      };
    }

    const groupThreads = Array.isArray(data.groupThreads) ? data.groupThreads : [];
    state.data.groups.threads = {};
    for (const gt of groupThreads) {
      if (!gt?.group?.id) continue;
      state.data.groups.threads[gt.group.id] = {
        info: gt.group,
        messages: Array.isArray(gt.messages) ? gt.messages : [],
        cursor: gt.cursor ?? null,
        hasMore: gt.hasMore ?? true,
      };
    }

    state.ui.skeleton = false;
    hideLoading();
  }

  function pickColor(seed) {
    // deterministic-ish color per username (client fallback; server should persist)
    const s = safeText(seed) || "user";
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    const hues = [210, 190, 170, 140, 120, 100, 80, 260, 280, 300, 320, 340];
    const hue = hues[h % hues.length];
    const sat = 70;
    const light = 62;
    return `hsl(${hue} ${sat}% ${light}%)`;
  }

  async function afterAuthBoot() {
    showApp();
    showLoading("Preparing…", "boot");
    await sleep(160);

    try {
      await bootstrap();
    } catch (e) {
      console.error(e);
      toast.show("Failed to load state.", "err", 2200);
      showLogin();
      return;
    }

    await initSocket();
    state.ui.bootstrapped = true;

    renderTop();
    renderMain();
    hideLoading();

    // default view: global
    openGlobal();
  }

  // -----------------------------
  // Socket.IO (requires server support)
  // -----------------------------
  async function initSocket() {
    if (!window.io || !state.session.token) return;

    try {
      state.socket?.removeAllListeners?.();
      state.socket?.disconnect?.();
    } catch {}
    state.socket = null;

    const socket = io({
      transports: ["websocket", "polling"],
      auth: { token: state.session.token },
    });
    state.socket = socket;

    socket.on("connect", () => {
      socket.emit("auth", { token: state.session.token });
      socket.emit("presence:set", { mode: state.settings.presenceMode || "online" });
    });

    // Expect: {count, users:[{id,username,mode}]}
    socket.on("users:online", (payload) => {
      const users = Array.isArray(payload?.users) ? payload.users : [];
      state.ui.onlineUsers = users.map((u) => ({
        id: u.id,
        username: u.username,
        mode: u.mode || "online",
      }));
      state.data.onlineCount =
        typeof payload?.count === "number"
          ? payload.count
          : (state.ui.onlineUsers?.length || 0);
      renderOnlineUsersPanel();
    });

    socket.on("presence:update", (payload) => {
      if (payload?.me?.mode) setPresenceUi(payload.me.mode);
      // If server also sends updated online users, refresh list
      if (Array.isArray(payload?.users)) {
        state.ui.onlineUsers = payload.users.map((u) => ({
          id: u.id,
          username: u.username,
          mode: u.mode || "online",
        }));
        renderOnlineUsersPanel();
      }
    });

    socket.on("message:new", (m) => {
      if (!m) return;
      // Ensure user color exists (fallback)
      if (m.user && !m.user.color) m.user.color = pickColor(m.user.username || "user");
      ingestMessage(m);
    });

    socket.on("message:edit", (m) => {
      // optional: implement edit if your server emits it
      // (kept minimal here)
      if (!m?.id) return;
      const th = getThread(m.scope, m.targetId || null);
      if (!th?.messages) return;
      const idx = th.messages.findIndex((x) => x.id === m.id);
      if (idx >= 0) {
        th.messages[idx] = { ...th.messages[idx], ...m };
        renderThread(state.ui.scope, state.ui.targetId);
      }
    });

    socket.on("message:delete", (p) => {
      if (!p?.messageId) return;
      const th = getThread(p.scope, p.targetId || null);
      if (!th?.messages) return;
      const idx = th.messages.findIndex((x) => x.id === p.messageId);
      if (idx >= 0) th.messages.splice(idx, 1);
      renderThread(state.ui.scope, state.ui.targetId);
    });

    socket.on("session:revoked", () => {
      toast.show("Session ended (signed in elsewhere).", "warn", 2400);
      doLogout();
    });

    socket.on("connect_error", (err) => {
      console.warn("socket connect_error:", err?.message);
    });
  }

  // -----------------------------
  // Main layout rendering (right panel = online users)
  // -----------------------------
  function renderMain() {
    // right panel always online users in this build
    renderOnlineUsersPanel();

    // basic header text
    if (dom.centerH) dom.centerH.textContent = "Global";
    if (dom.centerS) dom.centerS.textContent = "";
  }

  // -----------------------------
  // Thread open helpers
  // -----------------------------
  function openGlobal() {
    state.ui.scope = "global";
    state.ui.targetId = null;
    if (dom.centerH) dom.centerH.textContent = "Global";
    if (dom.centerS) dom.centerS.textContent = "";
    renderThread("global", null);
  }

  function openDm(peerId) {
    if (!peerId) return;
    state.ui.scope = "dm";
    state.ui.targetId = peerId;
    const th = state.data.dms.threads[peerId];
    const name = th?.peer?.username || "DM";
    if (dom.centerH) dom.centerH.textContent = `DM • ${name}`;
    if (dom.centerS) dom.centerS.textContent = "";
    renderThread("dm", peerId);
  }

  function openGroup(gid) {
    if (!gid) return;
    state.ui.scope = "group";
    state.ui.targetId = gid;
    const th = state.data.groups.threads[gid];
    const name = th?.info?.name || "Group Chat";
    if (dom.centerH) dom.centerH.textContent = `Group Chat • ${name}`;
    if (dom.centerS) dom.centerS.textContent = "";
    renderThread("group", gid);
  }

  // -----------------------------
  // Refresh current (single definition; avoids the earlier bug)
  // -----------------------------
  async function refreshCurrent() {
    const scope = state.ui.scope;
    const targetId = state.ui.targetId;

    try {
      showLoading("Refreshing…", "refresh");

      if (scope === "global") {
        const resp = await api(`/api/messages/global?limit=80`, { method: "GET" });
        if (resp?.ok) {
          state.data.global.messages = Array.isArray(resp.messages) ? resp.messages : [];
          state.data.global.cursor = resp.cursor ?? null;
          state.data.global.hasMore = resp.hasMore ?? true;
          renderThread("global", null);
        }
      } else if (scope === "dm" && targetId) {
        const resp = await api(`/api/messages/dm/${encodeURIComponent(targetId)}?limit=80`, { method: "GET" });
        if (resp?.ok) {
          const th =
            state.data.dms.threads[targetId] ||
            (state.data.dms.threads[targetId] = {
              peer: { id: targetId, username: "User" },
              messages: [],
              cursor: null,
              hasMore: true,
            });
          th.messages = Array.isArray(resp.messages) ? resp.messages : [];
          th.cursor = resp.cursor ?? null;
          th.hasMore = resp.hasMore ?? true;
          if (resp.peer) th.peer = resp.peer;
          renderThread("dm", targetId);
        }
      } else if (scope === "group" && targetId) {
        const resp = await api(`/api/messages/group/${encodeURIComponent(targetId)}?limit=90`, { method: "GET" });
        if (resp?.ok) {
          const th =
            state.data.groups.threads[targetId] ||
            (state.data.groups.threads[targetId] = {
              info: { id: targetId, name: "Group Chat" },
              messages: [],
              cursor: null,
              hasMore: true,
            });
          th.messages = Array.isArray(resp.messages) ? resp.messages : [];
          th.cursor = resp.cursor ?? null;
          th.hasMore = resp.hasMore ?? true;
          if (resp.group) th.info = resp.group;
          renderThread("group", targetId);
        }
      }
    } catch (e) {
      console.warn(e);
      toast.show("Refresh failed.", "err", 1800);
    } finally {
      hideLoading();
    }
  }

  // -----------------------------
  // Basic composer wiring
  // -----------------------------
  if (dom.btnSend) {
    dom.btnSend.addEventListener("click", () => {
      sendMessage(dom.msgInput?.value || "");
    });
  }

  if (dom.msgInput) {
    dom.msgInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage(dom.msgInput.value || "");
      }
    });
  }

  // -----------------------------
  // Header buttons
  // -----------------------------
  dom.btnLogout?.addEventListener("click", doLogout);
  dom.btnRefresh?.addEventListener("click", refreshCurrent);

  // -----------------------------
  // Login wiring
  // -----------------------------
  dom.btnLogin?.addEventListener("click", () => {
    const u = dom.loginUser?.value?.trim() || "";
    const p = dom.loginPass?.value || "";
    if (!u || !p) {
      setLoginMessage("Enter username and password.", true);
      return;
    }
    doLogin(u, p);
  });

  dom.btnGuest?.addEventListener("click", () => doGuest());

  dom.loginPass?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") dom.btnLogin?.click();
  });

  dom.loginUser?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") dom.loginPass?.focus();
  });

  // -----------------------------
  // Warm start
  // -----------------------------
  async function warmStart() {
    // apply cursor immediately
    applyCursorMode();

    // If token exists, try restoring
    if (state.session.token) {
      showApp();
      showLoading("Restoring session…", "resume");

      try {
        const me = await api("/api/users/me", { method: "GET" });
        if (me?.ok && me.user) {
          state.session.user = me.user;
          if (!state.session.user.color) state.session.user.color = pickColor(state.session.user.username || "user");
          localSet("tk_user", state.session.user);
          await afterAuthBoot();
          return;
        }
      } catch (e) {
        console.warn("resume failed:", e?.message);
      }

      // invalid token
      localSet("tk_token", null);
      localSet("tk_user", null);
      state.session.token = null;
      state.session.user = null;
      hideLoading();
      showLogin();
      return;
    }

    showLogin();
  }

  // Global error guards
  window.addEventListener("error", (e) => console.warn("window error:", e?.message));
  window.addEventListener("unhandledrejection", (e) => console.warn("unhandled rejection:", e?.reason?.message || e?.reason));

  warmStart();
})();
