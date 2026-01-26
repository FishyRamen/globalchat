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
    const speed = Math.min(1, Math.hypot(cur.vx, cur.v
