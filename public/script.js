/* public/script.js
   tonkotsu.online — compact black client (works with server.js + Socket.IO)

   This file:
   - Login (username+password) and Guest login
   - No inbox on login screen
   - Post-login loading screen
   - Tabs: Global (default), Messages, Group Chats, What’s New, Settings
   - Send messages + Enter to send
   - Right-click context menu: Edit/Delete within 1 minute; Report (to webhook)
   - Typing indicators (global/dm/group)
   - Read markers + Jump to last read
   - Auto-mod filtering (client-side mirror; server enforces too)
   - Compact black only (no theme switch)
   - Settings: accessibility, sound, cursor options, font size, filters
   - Custom cursor enabled by default (bigger + dynamic) + anti-flash watchdog
   - Skeleton loaders
   - User card modal + presence modes (no custom status)
   - Group chat owner tools UI hooks (server enforces)
   - Removes “beta info button” behavior (no beta toggle logic here)
   - Subtitle is ONLY: "tonkotsu.online" + small "beta" badge (expects index.html elements)

   Required DOM IDs in index.html:
     #loginWrap #loginUser #loginPass #loginMsg #btnLogin #btnGuest
     #loading #loadMsg #loadTag
     #app
     #subtitle #btnUser #btnLogout
     #presencePill #presenceDot #presenceLabel #onlineCount
     .nav-item[data-tab="global|messages|groups|whatsnew|settings"] and #navTag
     #centerH #centerS #centerBody #btnJumpLastRead #btnRefresh
     #composer #msgInput #btnSend #typingText #cooldownText
     #rightLabel #rightBody #btnRightAction
     #backdrop #modalTitle #modalBody #modalFoot #modalClose
     #ctx
     #cursor #trail

   Server endpoints expected:
     POST /api/auth/login  {username,password} -> {ok, token, user}
     POST /api/auth/guest  {} -> {ok, token, user}
     POST /api/auth/logout {} -> {ok}
     GET  /api/users/me -> {ok,user}
     GET  /api/state/bootstrap -> {ok, global, dms, friends, groups, groupThreads, whatsNew, lastRead, onlineCount}
     GET  /api/messages/global?before=&limit=
     GET  /api/messages/dm/:peerId?before=&limit=
     GET  /api/messages/group/:groupId?before=&limit=
     POST /api/messages/send {scope, targetId?, text, clientId}
     POST /api/messages/edit {messageId, text}
     POST /api/messages/delete {messageId}
     POST /api/messages/report {messageId, reason?}
     GET  /api/groups -> {ok, groups}
     POST /api/groups/create {name, limit, cooldownSeconds}
     POST /api/groups/update {groupId, patch}
     POST /api/groups/inviteLink {groupId}
     GET  /api/settings -> {ok, settings}
     POST /api/settings -> {ok, settings}

   Socket.IO events:
     server->client: users:online, presence:update,
                     message:new, message:edit, message:delete,
                     typing:update, read:update,
                     session:revoked, groups:update, dms:update
     client->server: auth, typing, read, presence:set, groups:join, dm:open
*/

(() => {
  "use strict";

  /* -----------------------------
     Utilities
  ----------------------------- */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const now = () => Date.now();
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const safeText = (s) => (typeof s === "string" ? s : "");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  function escapeHtml(str) {
    return safeText(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
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

  function beep(type = "send") {
    if (!state.settings.sound.enabled) return;
    const vol = clamp(state.settings.sound.volume, 0, 1);
    if (vol <= 0) return;

    try {
      const ctx = state.audioCtx || (state.audioCtx = new (window.AudioContext || window.webkitAudioContext)());
      const o = ctx.createOscillator();
      const g = ctx.createGain();

      const base = type === "recv" ? 520 : type === "err" ? 180 : 420;
      const freq = base + (Math.random() * 18 - 9);

      o.frequency.value = freq;
      o.type = "sine";
      g.gain.value = 0.0001;

      o.connect(g);
      g.connect(ctx.destination);

      const t = ctx.currentTime;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05 * vol, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);

      o.start(t);
      o.stop(t + 0.13);
    } catch {}
  }

  /* -----------------------------
     Auto-mod (client-side mirror)
  ----------------------------- */

  const wordLists = {
    globalBlocked: [
      "nazi",
      "hitler",
      "rape",
      "cp",
      "child porn",
      "terrorist",
      "kys",
      "kill yourself",
      "suicide",
      "bomb threat",
      "shoot up",
      "massacre",
    ],
    mild: ["shit", "fuck", "bitch", "asshole", "cunt", "nigger", "faggot"],
    sexual18: ["porn", "hentai", "xxx", "onlyfans", "nsfw", "sex", "blowjob", "handjob", "nudes"],
  };

  function normalizeForFilter(s) {
    return safeText(s)
      .toLowerCase()
      .replaceAll(/[\u200B-\u200D\uFEFF]/g, "")
      .replaceAll(/[^a-z0-9\s]/g, " ")
      .replaceAll(/\s+/g, " ")
      .trim();
  }

  function containsBlocked(text, scope) {
    const t = normalizeForFilter(text);
    if (!t) return { hit: false };

    if (scope === "global") {
      for (const w of wordLists.globalBlocked) if (t.includes(w)) return { hit: true, word: w, kind: "globalBlocked" };
      if (state.settings.filters.globalProfanityBlock) {
        for (const w of wordLists.mild) if (t.includes(w)) return { hit: true, word: w, kind: "mild" };
      }
      for (const w of wordLists.sexual18) if (t.includes(w)) return { hit: true, word: w, kind: "18plus" };
      return { hit: false };
    }

    const level = state.settings.filters.profanityLevel; // 0..2
    if (level >= 2) {
      for (const w of wordLists.globalBlocked.concat(wordLists.mild)) if (t.includes(w)) return { hit: true, word: w, kind: "strict" };
    } else if (level === 1) {
      for (const w of wordLists.mild) if (t.includes(w)) return { hit: true, word: w, kind: "mild" };
    }

    if (state.settings.filters.adultBlock) {
      for (const w of wordLists.sexual18) if (t.includes(w)) return { hit: true, word: w, kind: "18plus" };
    }

    return { hit: false };
  }

  function censorText(text) {
    let out = safeText(text);
    const tNorm = normalizeForFilter(out);
    if (!tNorm) return out;

    const patterns = wordLists.globalBlocked
      .concat(wordLists.mild, wordLists.sexual18)
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .sort((a, b) => b.length - a.length);

    for (const p of patterns) {
      const re = new RegExp(`\\b${p}\\b`, "gi");
      out = out.replace(re, (m) => "■".repeat(Math.min(8, Math.max(3, m.length))));
    }
    return out;
  }

  /* -----------------------------
     State
  ----------------------------- */

  const state = {
    session: {
      token: localGet("tk_token", null),
      user: localGet("tk_user", null),
      lastLoginAt: localGet("tk_lastLoginAt", 0),
    },
    ui: {
      tab: "global", // global, messages, groups, whatsnew, settings
      scope: "global",
      targetId: null,
      skeleton: true,
      bootstrapped: false,
      context: { open: false, msgId: null },
      typing: { lastUpdateAt: 0 },
      cooldown: { until: 0 },
      lastRead: { global: null, dm: {}, group: {} },
    },
    data: {
      global: { messages: [], hasMore: true, cursor: null },
      dms: { threads: {}, friends: [] },
      groups: { list: [], threads: {} },
      whatsNew: [],
      onlineCount: 0,
    },
    settings: {
      accessibility: { reducedMotion: false, highContrast: false, focusRings: true },
      sound: { enabled: true, volume: 0.35 },
      cursor: { enabled: true, size: 1.35, dynamic: true },
      fontScale: 1.0,
      filters: {
        globalProfanityBlock: false,
        profanityLevel: 1,
        adultBlock: true,
      },
      presenceMode: "online",
    },
    audioCtx: null,
    socket: null,
  };

  /* -----------------------------
     DOM cache
  ----------------------------- */

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

    subtitle: $("#subtitle"),
    btnUser: $("#btnUser"),
    btnLogout: $("#btnLogout"),
    presencePill: $("#presencePill"),
    presenceDot: $("#presenceDot"),
    presenceLabel: $("#presenceLabel"),
    onlineCount: $("#onlineCount"),

    navTag: $("#navTag"),
    navItems: $$(".nav-item"),

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

    rightLabel: $("#rightLabel"),
    rightBody: $("#rightBody"),
    btnRightAction: $("#btnRightAction"),

    backdrop: $("#backdrop"),
    modalTitle: $("#modalTitle"),
    modalBody: $("#modalBody"),
    modalFoot: $("#modalFoot"),
    modalClose: $("#modalClose"),

    ctx: $("#ctx"),

    cursor: $("#cursor"),
    trail: $("#trail"),
  };

  /* -----------------------------
     Settings apply / persistence
  ----------------------------- */

  function deepMerge(base, patch) {
    if (!patch || typeof patch !== "object") return base;
    const out = Array.isArray(base) ? base.slice() : { ...base };
    for (const [k, v] of Object.entries(patch)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = deepMerge(base[k] && typeof base[k] === "object" ? base[k] : {}, v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function applySettingsToDom() {
    // Theme is compact black only (assumes CSS in index.html reads these attributes)
    document.documentElement.setAttribute("data-theme", "compact-black");

    // Font scale buckets (0.9..1.3)
    const fs = clamp(state.settings.fontScale, 0.9, 1.3);
    const buckets = [0.9, 1.0, 1.1, 1.2, 1.3];
    const nearest = buckets.reduce((a, b) => (Math.abs(b - fs) < Math.abs(a - fs) ? b : a), 1.0);
    document.body.setAttribute("data-fontscale", nearest.toFixed(1));

    // Accessibility
    document.body.setAttribute("data-reducedmotion", state.settings.accessibility.reducedMotion ? "1" : "0");
    document.body.setAttribute("data-highcontrast", state.settings.accessibility.highContrast ? "1" : "0");
    document.body.setAttribute("data-focusrings", state.settings.accessibility.focusRings ? "1" : "0");

    // Custom cursor
    const enabled = !!state.settings.cursor.enabled;
    document.body.style.cursor = enabled ? "none" : "auto";

    if (dom.cursor) {
      dom.cursor.style.display = enabled ? "block" : "none";
      dom.cursor.style.pointerEvents = "none";
    }
    if (dom.trail) {
      dom.trail.style.display = enabled ? "block" : "none";
      dom.trail.style.pointerEvents = "none";
    }

    // Safety: if cursor is enabled, ensure native cursor stays hidden (some browsers reapply).
    if (enabled) {
      document.documentElement.style.cursor = "none";
    } else {
      document.documentElement.style.cursor = "";
    }
  }

  function loadSettingsFromLocal() {
    const s = localGet("tk_settings", null);
    if (s && typeof s === "object") state.settings = deepMerge(state.settings, s);
    // Hard force cursor enabled by default unless user explicitly disabled it
    if (typeof s?.cursor?.enabled !== "boolean") state.settings.cursor.enabled = true;
    applySettingsToDom();
  }

  function saveSettingsToLocal() {
    localSet("tk_settings", state.settings);
  }

  async function syncSettingsFromServer() {
    if (!state.session.token) return;
    try {
      const s = await api("/api/settings", { method: "GET" });
      if (s?.ok && s.settings) {
        state.settings = deepMerge(state.settings, s.settings);
        // Maintain compact black & cursor default behavior
        if (typeof s.settings?.cursor?.enabled !== "boolean") state.settings.cursor.enabled = true;
        saveSettingsToLocal();
        applySettingsToDom();
      }
    } catch {}
  }

  async function saveSettingsToServer() {
    saveSettingsToLocal();
    applySettingsToDom();
    if (!state.session.token) return;
    try {
      const resp = await api("/api/settings", { method: "POST", body: { settings: state.settings } });
      if (resp?.ok && resp.settings) {
        state.settings = deepMerge(state.settings, resp.settings);
        saveSettingsToLocal();
        applySettingsToDom();
      }
    } catch {}
  }

  // Cursor anti-flash watchdog: re-apply cursor hide every 400ms if enabled.
  setInterval(() => {
    if (!state.settings.cursor.enabled) return;
    if (document.body.style.cursor !== "none") document.body.style.cursor = "none";
    if (document.documentElement.style.cursor !== "none") document.documentElement.style.cursor = "none";
    if (dom.cursor && dom.cursor.style.display !== "block") dom.cursor.style.display = "block";
    if (dom.trail && dom.trail.style.display !== "block") dom.trail.style.display = "block";
  }, 400);

  /* -----------------------------
     Modal helpers
  ----------------------------- */

  function closeModal() {
    dom.backdrop?.classList.remove("show");
    if (dom.modalTitle) dom.modalTitle.textContent = "";
    if (dom.modalBody) dom.modalBody.innerHTML = "";
    if (dom.modalFoot) dom.modalFoot.innerHTML = "";
  }

  function openModal(title, bodyHtml, footButtons = []) {
    if (dom.modalTitle) dom.modalTitle.textContent = title;
    if (dom.modalBody) dom.modalBody.innerHTML = bodyHtml;
    if (dom.modalFoot) dom.modalFoot.innerHTML = "";

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

  /* -----------------------------
     Login / Logout
  ----------------------------- */

  function setLoginMessage(msg, isError = false) {
    if (!dom.loginMsg) return;
    dom.loginMsg.textContent = msg;
    dom.loginMsg.style.color = isError ? "rgba(255,92,122,.95)" : "";
  }

  async function doLogin(username, password) {
    setLoginMessage("Signing in…");
    try {
      const data = await api("/api/auth/login", {
        method: "POST",
        body: { username, password },
      });

      if (!data?.ok || !data.token) throw new Error(data?.error || "Login failed");

      state.session.token = data.token;
      state.session.user = data.user || { username };
      localSet("tk_token", state.session.token);
      localSet("tk_user", state.session.user);
      localSet("tk_lastLoginAt", Date.now());

      await afterAuthBoot();
    } catch (e) {
      beep("err");
      setLoginMessage(e.message || "Login failed", true);
      console.error(e);
    }
  }

  async function doGuest() {
    setLoginMessage("Starting guest session…");
    try {
      const data = await api("/api/auth/guest", { method: "POST", body: {} });
      if (!data?.ok || !data.token) throw new Error(data?.error || "Guest login failed");

      state.session.token = data.token;
      state.session.user = data.user || { username: "guest" };
      localSet("tk_token", state.session.token);
      localSet("tk_user", state.session.user);
      localSet("tk_lastLoginAt", Date.now());

      await afterAuthBoot();
    } catch (e) {
      beep("err");
      setLoginMessage(e.message || "Guest login failed", true);
      console.error(e);
    }
  }

  async function doLogout() {
    try {
      await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => {});
    } finally {
      teardownSocket();

      state.session.token = null;
      state.session.user = null;
      localSet("tk_token", null);
      localSet("tk_user", null);

      // reset
      state.ui.tab = "global";
      state.ui.scope = "global";
      state.ui.targetId = null;
      state.ui.skeleton = true;
      state.ui.bootstrapped = false;

      state.data.global = { messages: [], hasMore: true, cursor: null };
      state.data.dms = { threads: {}, friends: [] };
      state.data.groups = { list: [], threads: {} };
      state.data.whatsNew = [];
      state.data.onlineCount = 0;

      showLogin();
    }
  }

  function showLogin() {
    if (dom.app) dom.app.style.display = "none";
    if (dom.loginWrap) dom.loginWrap.style.display = "flex";
    dom.loading?.classList.remove("show");

    if (dom.centerBody) dom.centerBody.innerHTML = "";
    if (dom.rightBody) dom.rightBody.innerHTML = "";

    // Keep it simple
    setLoginMessage("Sign in or use Guest.");

    if (dom.loginUser) dom.loginUser.value = "";
    if (dom.loginPass) dom.loginPass.value = "";
  }

  function showApp() {
    if (dom.loginWrap) dom.loginWrap.style.display = "none";
    if (dom.app) dom.app.style.display = "flex";
  }

  function showLoading(msg = "Loading…", tag = "sync") {
    if (dom.loadMsg) dom.loadMsg.textContent = msg;
    if (dom.loadTag) dom.loadTag.textContent = tag;
    dom.loading?.classList.add("show");
  }

  function hideLoading() {
    dom.loading?.classList.remove("show");
  }

  async function afterAuthBoot() {
    // Always apply local settings immediately
    loadSettingsFromLocal();
    await syncSettingsFromServer().catch(() => {});

    showApp();
    showLoading("Preparing…", "boot");
    await sleep(220);

    await bootstrap();
    await initSocket();
    state.ui.bootstrapped = true;

    hideLoading();
    setTab("global");
  }

  /* -----------------------------
     Bootstrap + skeleton
  ----------------------------- */

  function renderSkeletonCenter(lines = 6) {
    if (!dom.centerBody) return;
    dom.centerBody.innerHTML = "";
    for (let i = 0; i < lines; i++) {
      const sk = document.createElement("div");
      sk.className = "skeleton";
      sk.innerHTML = `
        <div class="sk-row w70"></div>
        <div class="sk-row w90"></div>
        <div class="sk-row w50"></div>
      `;
      dom.centerBody.appendChild(sk);
    }
  }

  function renderSkeletonRight(cards = 3) {
    if (!dom.rightBody) return;
    dom.rightBody.innerHTML = "";
    for (let i = 0; i < cards; i++) {
      const c = document.createElement("div");
      c.className = "card skeleton";
      c.innerHTML = `
        <div class="sk-row w50"></div>
        <div class="sk-row w90"></div>
        <div class="sk-row w70"></div>
      `;
      dom.rightBody.appendChild(c);
    }
  }

  async function bootstrap() {
    state.ui.skeleton = true;
    renderSkeletonCenter(7);
    renderSkeletonRight(3);

    try {
      const data = await api("/api/state/bootstrap", { method: "GET" });
      if (!data?.ok) throw new Error(data?.error || "Bootstrap failed");

      // Global
      state.data.global.messages = Array.isArray(data.global?.messages) ? data.global.messages : [];
      state.data.global.cursor = data.global?.cursor ?? null;
      state.data.global.hasMore = data.global?.hasMore ?? true;

      // Friends + DM threads
      state.data.dms.friends = Array.isArray(data.friends) ? data.friends : [];
      state.data.dms.threads = {};

      const dmThreads = Array.isArray(data.dms) ? data.dms : [];
      for (const th of dmThreads) {
        if (!th?.peer?.id) continue;
        state.data.dms.threads[th.peer.id] = {
          peer: th.peer,
          messages: Array.isArray(th.messages) ? th.messages : [],
          cursor: th.cursor ?? null,
          hasMore: th.hasMore ?? true,
          lastRead: th.lastRead ?? null,
        };
      }

      // Groups
      state.data.groups.list = Array.isArray(data.groups) ? data.groups : [];
      const groupThreads = Array.isArray(data.groupThreads) ? data.groupThreads : [];
      state.data.groups.threads = {};
      for (const gt of groupThreads) {
        if (!gt?.group?.id) continue;
        state.data.groups.threads[gt.group.id] = {
          info: gt.group,
          messages: Array.isArray(gt.messages) ? gt.messages : [],
          cursor: gt.cursor ?? null,
          hasMore: gt.hasMore ?? true,
          lastRead: gt.lastRead ?? null,
        };
      }

      // What’s New
      state.data.whatsNew = Array.isArray(data.whatsNew) ? data.whatsNew : [];

      // Read markers
      const lr = data.lastRead || {};
      state.ui.lastRead.global = lr.global ?? null;
      state.ui.lastRead.dm = lr.dm || {};
      state.ui.lastRead.group = lr.group || {};

      // Online count
      state.data.onlineCount = data.onlineCount ?? 0;
      if (dom.onlineCount) dom.onlineCount.textContent = String(state.data.onlineCount);

      state.ui.skeleton = false;
    } catch (e) {
      console.error(e);
      openModal(
        "Load error",
        `<div class="warn">Failed to load: <b>${escapeHtml(e.message || "unknown error")}</b></div>`,
        [
          { label: "Retry", kind: "primary", onClick: async () => { closeModal(); await bootstrap(); render(); } },
          { label: "Log out", kind: "danger", onClick: async () => { closeModal(); await doLogout(); } },
        ]
      );
    } finally {
      state.ui.skeleton = false;
    }
  }

  /* -----------------------------
     Socket.IO
  ----------------------------- */

  async function initSocket() {
    if (!window.io) return;

    teardownSocket();

    const socket = io({
      transports: ["websocket", "polling"],
      auth: { token: state.session.token },
    });
    state.socket = socket;

    socket.on("connect", () => {
      socket.emit("auth", { token: state.session.token });
      socket.emit("presence:set", { mode: state.settings.presenceMode || "online" });
    });

    socket.on("users:online", (payload) => {
      const n = payload?.count ?? payload?.onlineCount ?? 0;
      state.data.onlineCount = n;
      if (dom.onlineCount) dom.onlineCount.textContent = String(n);
    });

    socket.on("presence:update", (payload) => {
      if (payload?.me?.mode) setPresenceUi(payload.me.mode);
    });

    socket.on("message:new", (m) => m && ingestMessage(m, { notify: true }));
    socket.on("message:edit", (m) => m && applyMessageEdit(m));
    socket.on("message:delete", (p) => p?.messageId && applyMessageDelete(p.messageId, p.scope, p.targetId));

    socket.on("typing:update", (p) => updateTypingUi(p));
    socket.on("read:update", (p) => p && applyReadUpdate(p));

    socket.on("groups:update", (payload) => {
      if (Array.isArray(payload?.groups)) {
        // best-effort merge: server may send raw groups
        state.data.groups.list = payload.groups.map((g) => ({
          id: g.id,
          name: g.name,
          ownerId: g.ownerId,
          ownerUsername: g.ownerUsername || "",
          limit: g.limit,
          cooldownSeconds: g.cooldownSeconds,
          rules: g.rules || "",
        }));
        if (state.ui.tab === "groups") renderRight();
      }
    });

    socket.on("dms:update", (payload) => {
      if (Array.isArray(payload?.friends)) state.data.dms.friends = payload.friends;
      if (state.ui.tab === "messages") renderRight();
    });

    socket.on("session:revoked", () => {
      openModal(
        "Session ended",
        `<div class="warn">This account was signed in elsewhere.</div>`,
        [{ label: "Log out", kind: "danger", onClick: async () => { closeModal(); await doLogout(); } }]
      );
    });

    socket.on("connect_error", (err) => {
      console.warn("socket connect_error:", err?.message);
    });
  }

  function teardownSocket() {
    if (state.socket) {
      try {
        state.socket.removeAllListeners();
        state.socket.disconnect();
      } catch {}
      state.socket = null;
    }
  }

  /* -----------------------------
     Presence (no custom status)
  ----------------------------- */

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
    saveSettingsToLocal();
    setPresenceUi(mode);
    if (state.socket) state.socket.emit("presence:set", { mode });
  }

  /* -----------------------------
     Tabs + rendering
  ----------------------------- */

  function setTab(tab) {
    state.ui.tab = tab;

    for (const it of dom.navItems || []) {
      it.classList.toggle("active", it.getAttribute("data-tab") === tab);
    }
    if (dom.navTag) dom.navTag.textContent = tab;

    if (tab === "global") {
      state.ui.scope = "global";
      state.ui.targetId = null;
      if (dom.centerH) dom.centerH.textContent = "Global";
      if (dom.centerS) dom.centerS.textContent = "";
      if (dom.rightLabel) dom.rightLabel.textContent = "Info";
      if (dom.btnRightAction) dom.btnRightAction.textContent = "Rules";
      if (dom.composer) dom.composer.style.display = "flex";
    } else if (tab === "messages") {
      if (dom.centerH) dom.centerH.textContent = "Messages";
      if (dom.centerS) dom.centerS.textContent = "";
      if (dom.rightLabel) dom.rightLabel.textContent = "Friends";
      if (dom.btnRightAction) dom.btnRightAction.textContent = "Add";
      if (dom.composer) dom.composer.style.display = "flex";

      if (!(state.ui.scope === "dm" && state.ui.targetId)) {
        const first = pickFirstDmPeer();
        if (first) openDm(first);
        else {
          state.ui.scope = "system";
          state.ui.targetId = null;
        }
      }
    } else if (tab === "groups") {
      if (dom.centerH) dom.centerH.textContent = "Group Chats";
      if (dom.centerS) dom.centerS.textContent = "";
      if (dom.rightLabel) dom.rightLabel.textContent = "Group Chats";
      if (dom.btnRightAction) dom.btnRightAction.textContent = "Create";
      if (dom.composer) dom.composer.style.display = "flex";

      if (!(state.ui.scope === "group" && state.ui.targetId)) {
        const g = state.data.groups.list[0];
        if (g?.id) openGroup(g.id);
        else {
          state.ui.scope = "system";
          state.ui.targetId = null;
        }
      }
    } else if (tab === "whatsnew") {
      if (dom.centerH) dom.centerH.textContent = "What’s New";
      if (dom.centerS) dom.centerS.textContent = "";
      if (dom.rightLabel) dom.rightLabel.textContent = "Preview";
      if (dom.btnRightAction) dom.btnRightAction.textContent = "Try";
      if (dom.composer) dom.composer.style.display = "none";
      state.ui.scope = "system";
      state.ui.targetId = null;
    } else if (tab === "settings") {
      if (dom.centerH) dom.centerH.textContent = "Settings";
      if (dom.centerS) dom.centerS.textContent = "";
      if (dom.rightLabel) dom.rightLabel.textContent = "Account";
      if (dom.btnRightAction) dom.btnRightAction.textContent = "Session";
      if (dom.composer) dom.composer.style.display = "none";
      state.ui.scope = "system";
      state.ui.targetId = null;
    }

    render();
  }

  function pickFirstDmPeer() {
    const thIds = Object.keys(state.data.dms.threads || {});
    if (thIds.length) return thIds[0];
    const fr = state.data.dms.friends?.[0];
    return fr?.id || null;
  }

  function render() {
    renderTop();
    renderCenter();
    renderRight();
  }

  function renderTop() {
    // Subtitle must be only "tonkotsu.online" + beta badge (expects CSS)
    if (dom.subtitle) dom.subtitle.innerHTML = `tonkotsu.online <span class="beta">beta</span>`;
    if (dom.btnUser) dom.btnUser.textContent = state.session.user?.username || "user";
    setPresenceUi(state.settings.presenceMode || "online");
  }

  function renderCenter() {
    if (state.ui.skeleton) return;

    if (state.ui.tab === "global") renderMessageThread("global", null);
    else if (state.ui.tab === "messages") {
      if (state.ui.scope === "dm" && state.ui.targetId) renderMessageThread("dm", state.ui.targetId);
      else renderEmptyCenter("No DM selected", "Pick a friend on the right panel.");
    } else if (state.ui.tab === "groups") {
      if (state.ui.scope === "group" && state.ui.targetId) renderMessageThread("group", state.ui.targetId);
      else renderEmptyCenter("No group selected", "Create or select a group chat on the right panel.");
    } else if (state.ui.tab === "whatsnew") renderWhatsNew();
    else if (state.ui.tab === "settings") renderSettings();
  }

  function renderRight() {
    if (state.ui.skeleton) return;

    if (state.ui.tab === "global") renderGlobalInfo();
    else if (state.ui.tab === "messages") renderFriendsPanel();
    else if (state.ui.tab === "groups") renderGroupsPanel();
    else if (state.ui.tab === "whatsnew") renderWhatsNewPanel();
    else if (state.ui.tab === "settings") renderAccountPanel();
  }

  function renderEmptyCenter(title, desc) {
    if (!dom.centerBody) return;
    dom.centerBody.innerHTML = `
      <div class="card">
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(desc)}</p>
      </div>
    `;
  }

  /* -----------------------------
     Thread rendering
  ----------------------------- */

  function getThread(scope, targetId) {
    if (scope === "global") return state.data.global;
    if (scope === "dm") return state.data.dms.threads[targetId] || null;
    if (scope === "group") return state.data.groups.threads[targetId] || null;
    return null;
  }

  function threadTitle(scope, targetId) {
    if (scope === "global") return { h: "Global", s: "" };
    if (scope === "dm") {
      const th = state.data.dms.threads[targetId];
      const name = th?.peer?.username || "DM";
      return { h: `DM • ${name}`, s: "" };
    }
    if (scope === "group") {
      const th = state.data.groups.threads[targetId];
      const name = th?.info?.name || "Group Chat";
      return { h: `Group Chat • ${name}`, s: "" };
    }
    return { h: "Thread", s: "" };
  }

  function renderMessageThread(scope, targetId) {
    state.ui.scope = scope;
    state.ui.targetId = targetId;

    const tt = threadTitle(scope, targetId);
    if (dom.centerH) dom.centerH.textContent = tt.h;
    if (dom.centerS) dom.centerS.textContent = tt.s;

    const th = getThread(scope, targetId);
    const msgs = th?.messages || [];

    if (!dom.centerBody) return;
    dom.centerBody.innerHTML = "";

    if (!msgs.length) {
      dom.centerBody.innerHTML = `
        <div class="card">
          <h3>No messages</h3>
          <p>Send the first message.</p>
        </div>
      `;
      return;
    }

    const frag = document.createDocumentFragment();
    for (const m of msgs) frag.appendChild(renderMessageNode(m, scope, targetId));
    dom.centerBody.appendChild(frag);

    setTimeout(() => {
      dom.centerBody.scrollTop = dom.centerBody.scrollHeight;
      const last = msgs[msgs.length - 1];
      if (last?.id) emitRead(scope, targetId, last.id);
    }, 0);
  }

  function scopeLabel(scope) {
    if (scope === "global") return "global";
    if (scope === "dm") return "dm";
    if (scope === "group") return "group";
    return "system";
  }

  function censorMaybe(text, scope) {
    if (scope === "global") return censorText(text);
    if (state.settings.filters.adultBlock || state.settings.filters.profanityLevel >= 1) return censorText(text);
    return safeText(text);
  }

  function renderMessageNode(m, scope, targetId) {
    const el = document.createElement("div");
    el.className = "msg";
    el.setAttribute("data-id", m.id);
    el.setAttribute("data-scope", scope);
    el.setAttribute("data-target", targetId || "");
    el.setAttribute("data-ts", String(m.ts || 0));
    el.tabIndex = 0;

    const uname = escapeHtml(m.user?.username || "user");
    const bodyText = escapeHtml(censorMaybe(m.text, scope));
    const time = fmtTime(m.ts || Date.now());

    const badges = Array.isArray(m.user?.badges) ? m.user.badges : [];
    const badgeHtml = badges
      .slice(0, 4)
      .map((b) => {
        const t = escapeHtml(String(b).slice(0, 14));
        const cls = t.toLowerCase().includes("owner") || t.toLowerCase().includes("admin") ? "" : "gray";
        return `<span class="ub ${cls}">${t}</span>`;
      })
      .join("");

    const edited = m.editedAt ? `<span class="chip">edited</span>` : "";
    const pending = m.pending ? `<span class="chip">sending</span>` : "";
    const failed = m.failed ? `<span class="chip err">failed</span>` : "";

    el.innerHTML = `
      <div class="avatar" aria-hidden="true"></div>
      <div class="msg-main">
        <div class="msg-top">
          <div class="msg-user">
            <div class="uname">${uname}</div>
            <div class="ubadges">${badgeHtml}</div>
          </div>
          <div class="time">${escapeHtml(time)}</div>
        </div>
        <div class="body">${bodyText}</div>
        <div class="meta">
          ${edited}${pending}${failed}
          <span class="chip">${escapeHtml(scopeLabel(scope))}</span>
        </div>
      </div>
    `;

    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openContextMenuForMessage(e.clientX, e.clientY, m, scope, targetId);
    });

    el.addEventListener("click", () => {
      if (state.ui.context.open) return;
      openUserCard(m.user || {});
    });

    return el;
  }

  /* -----------------------------
     Context menu
  ----------------------------- */

  function closeContextMenu() {
    state.ui.context.open = false;
    if (dom.ctx) {
      dom.ctx.classList.remove("show");
      dom.ctx.innerHTML = "";
    }
  }

  function openContextMenuForMessage(x, y, m, scope, targetId) {
    closeContextMenu();

    const mine =
      (m.user?.id && state.session.user?.id && m.user.id === state.session.user.id) ||
      (m.user?.username && state.session.user?.username && m.user.username === state.session.user.username);

    const ageMs = Date.now() - (m.ts || 0);
    const canEditDelete = mine && ageMs <= 60_000;

    const items = [];
    if (canEditDelete) {
      items.push({ label: "Edit (1 min)", onClick: () => { closeContextMenu(); promptEditMessage(m); } });
      items.push({ label: "Delete (1 min)", danger: true, onClick: () => { closeContextMenu(); confirmDeleteMessage(m); } });
    }
    items.push({ label: "Report", danger: true, onClick: () => { closeContextMenu(); promptReportMessage(m); } });

    if (!dom.ctx) return;

    dom.ctx.innerHTML = items
      .map(
        (it, idx) => `
        <div class="item ${it.danger ? "danger" : ""}" data-idx="${idx}">
          <span>${escapeHtml(it.label)}</span>
          <span style="color:rgba(154,163,183,.7)">${it.danger ? "!" : ""}</span>
        </div>
      `
      )
      .join("");

    $$(".item", dom.ctx).forEach((node) => {
      const idx = Number(node.getAttribute("data-idx"));
      node.addEventListener("click", () => items[idx]?.onClick && items[idx].onClick());
    });

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = 200;
    const h = 46 * items.length;
    const px = clamp(x, 10, vw - w - 10);
    const py = clamp(y, 10, vh - h - 10);

    dom.ctx.style.left = `${px}px`;
    dom.ctx.style.top = `${py}px`;
    dom.ctx.classList.add("show");

    state.ui.context.open = true;
    state.ui.context.msgId = m.id;
  }

  document.addEventListener("click", () => state.ui.context.open && closeContextMenu());
  document.addEventListener("scroll", () => state.ui.context.open && closeContextMenu(), true);
  window.addEventListener("resize", () => state.ui.context.open && closeContextMenu());

  function promptEditMessage(m) {
    const scope = state.ui.scope;
    const blocked = containsBlocked(m.text, scope);
    const note = blocked.hit
      ? `<div class="warn">Blocked content detected (<b>${escapeHtml(blocked.word)}</b>). Your edit must remove it.</div>`
      : "";

    openModal(
      "Edit message",
      `
        ${note}
        <div class="small">Edits are allowed only within 1 minute.</div>
        <input id="editInput" class="input" value="${escapeHtml(m.text || "")}" />
      `,
      [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Save",
          kind: "primary",
          onClick: async () => {
            const val = $("#editInput")?.value ?? "";
            await editMessage(m.id, val);
            closeModal();
          },
        },
      ]
    );
  }

  function confirmDeleteMessage(m) {
    openModal(
      "Delete message",
      `<div class="warn">This deletes the message (allowed only within 1 minute).</div>`,
      [
        { label: "Cancel", onClick: closeModal },
        { label: "Delete", kind: "danger", onClick: async () => { await deleteMessage(m.id); closeModal(); } },
      ]
    );
  }

  function promptReportMessage(m) {
    openModal(
      "Report message",
      `
        <div class="small">This sends the message to moderation.</div>
        <input id="reportReason" class="input" placeholder="Reason (optional)" />
      `,
      [
        { label: "Cancel", onClick: closeModal },
        {
          label: "Report",
          kind: "danger",
          onClick: async () => {
            const reason = $("#reportReason")?.value ?? "";
            await reportMessage(m.id, reason);
            closeModal();
          },
        },
      ]
    );
  }

  /* -----------------------------
     Messaging actions
  ----------------------------- */

  function currentScopeForSend() {
    if (state.ui.tab === "global") return { scope: "global", targetId: null };
    if (state.ui.tab === "messages" && state.ui.scope === "dm") return { scope: "dm", targetId: state.ui.targetId };
    if (state.ui.tab === "groups" && state.ui.scope === "group") return { scope: "group", targetId: state.ui.targetId };
    return { scope: null, targetId: null };
  }

  function inCooldown() {
    return state.ui.cooldown.until && Date.now() < state.ui.cooldown.until;
  }

  function updateCooldownUi() {
    if (!dom.cooldownText) return;
    const t = state.ui.cooldown.until || 0;
    if (!t || Date.now() >= t) {
      state.ui.cooldown.until = 0;
      dom.cooldownText.textContent = "";
      return;
    }
    const sec = Math.ceil((t - Date.now()) / 1000);
    dom.cooldownText.textContent = `cooldown: ${sec}s`;
  }

  setInterval(updateCooldownUi, 250);

  async function sendMessage(text) {
    const { scope, targetId } = currentScopeForSend();
    if (!scope) return;

    const trimmed = safeText(text).trim();
    if (!trimmed) return;

    if (inCooldown()) {
      beep("err");
      return;
    }

    const block = containsBlocked(trimmed, scope);
    if (block.hit) {
      beep("err");
      openModal(
        "Message blocked",
        `<div class="warn">Blocked by filter (<b>${escapeHtml(block.word)}</b>).</div>`,
        [{ label: "OK", kind: "primary", onClick: closeModal }]
      );
      return;
    }

    if (dom.msgInput) dom.msgInput.value = "";
    beep("send");

    const localId = uid("localmsg");
    const m = {
      id: localId,
      ts: Date.now(),
      text: trimmed,
      scope,
      targetId,
      user: {
        id: state.session.user?.id,
        username: state.session.user?.username || "me",
        badges: state.session.user?.badges || [],
      },
      pending: true,
    };
    ingestMessage(m, { notify: false, optimistic: true });

    try {
      const resp = await api("/api/messages/send", { method: "POST", body: { scope, targetId, text: trimmed, clientId: localId } });
      if (resp?.ok && resp.message) replaceLocalMessage(localId, resp.message);
      if (resp?.cooldownUntil) state.ui.cooldown.until = resp.cooldownUntil;
    } catch (e) {
      beep("err");
      markLocalMessageFailed(localId, e.message || "send failed");
    }
  }

  async function editMessage(messageId, text) {
    const scope = state.ui.scope;
    const trimmed = safeText(text).trim();
    if (!trimmed) return;

    const block = containsBlocked(trimmed, scope === "dm" ? "dm" : scope === "group" ? "group" : "global");
    if (block.hit) {
      beep("err");
      openModal("Edit blocked", `<div class="warn">Blocked (<b>${escapeHtml(block.word)}</b>).</div>`, [{ label: "OK", kind: "primary", onClick: closeModal }]);
      return;
    }

    try {
      const resp = await api("/api/messages/edit", { method: "POST", body: { messageId, text: trimmed } });
      if (resp?.ok && resp.message) applyMessageEdit(resp.message);
    } catch (e) {
      beep("err");
      openModal("Edit failed", `<div class="warn">${escapeHtml(e.message || "Edit failed")}</div>`, [{ label: "OK", kind: "primary", onClick: closeModal }]);
    }
  }

  async function deleteMessage(messageId) {
    try {
      const resp = await api("/api/messages/delete", { method: "POST", body: { messageId } });
      if (resp?.ok) applyMessageDelete(messageId, state.ui.scope, state.ui.targetId);
    } catch (e) {
      beep("err");
      openModal("Delete failed", `<div class="warn">${escapeHtml(e.message || "Delete failed")}</div>`, [{ label: "OK", kind: "primary", onClick: closeModal }]);
    }
  }

  async function reportMessage(messageId, reason = "") {
    try {
      const resp = await api("/api/messages/report", { method: "POST", body: { messageId, reason } });
      if (resp?.ok) openModal("Reported", `<div class="small">Report sent.</div>`, [{ label: "OK", kind: "primary", onClick: closeModal }]);
    } catch (e) {
      beep("err");
      openModal("Report failed", `<div class="warn">${escapeHtml(e.message || "Report failed")}</div>`, [{ label: "OK", kind: "primary", onClick: closeModal }]);
    }
  }

  function isCurrentThread(scope, targetId) {
    if (state.ui.tab === "global") return scope === "global";
    if (state.ui.tab === "messages") return scope === "dm" && state.ui.scope === "dm" && state.ui.targetId === targetId;
    if (state.ui.tab === "groups") return scope === "group" && state.ui.scope === "group" && state.ui.targetId === targetId;
    return false;
  }

  function ingestMessage(m, { notify = false } = {}) {
    if (!m) return;

    if (m.scope === "global") {
      state.data.global.messages.push(m);
      state.data.global.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (isCurrentThread("global", null)) {
        renderCenter();
        if (notify && m.user?.username !== state.session.user?.username) beep("recv");
      }
      return;
    }

    if (m.scope === "dm") {
      const peerId = m.targetId || m.peerId || m.peer?.id;
      if (!peerId) return;

      if (!state.data.dms.threads[peerId]) {
        state.data.dms.threads[peerId] = {
          peer: m.peer || state.data.dms.friends.find((x) => x.id === peerId) || { id: peerId, username: "User" },
          messages: [],
          cursor: null,
          hasMore: true,
          lastRead: null,
        };
      }

      const th = state.data.dms.threads[peerId];
      th.messages.push(m);
      th.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));

      if (isCurrentThread("dm", peerId)) {
        renderCenter();
        if (notify && m.user?.username !== state.session.user?.username) beep("recv");
      }
      return;
    }

    if (m.scope === "group") {
      const gid = m.targetId || m.groupId;
      if (!gid) return;

      if (!state.data.groups.threads[gid]) {
        const info = state.data.groups.list.find((g) => g.id === gid) || { id: gid, name: "Group Chat" };
        state.data.groups.threads[gid] = { info, messages: [], cursor: null, hasMore: true, lastRead: null };
      }

      const th = state.data.groups.threads[gid];
      th.messages.push(m);
      th.messages.sort((a, b) => (a.ts || 0) - (b.ts || 0));

      if (isCurrentThread("group", gid)) {
        renderCenter();
        if (notify && m.user?.username !== state.session.user?.username) beep("recv");
      }
    }
  }

  function replaceLocalMessage(localId, realMessage) {
    const { scope, targetId } = realMessage;
    const th = getThread(scope, targetId);
    if (!th?.messages) return;
    const idx = th.messages.findIndex((x) => x.id === localId);
    if (idx >= 0) {
      th.messages[idx] = realMessage;
      if (isCurrentThread(scope, targetId)) renderCenter();
    }
  }

  function markLocalMessageFailed(localId, error) {
    const th = getThread(state.ui.scope, state.ui.targetId);
    if (!th?.messages) return;
    const idx = th.messages.findIndex((x) => x.id === localId);
    if (idx >= 0) {
      th.messages[idx].failed = true;
      th.messages[idx].error = error;
      th.messages[idx].pending = false;
      if (isCurrentThread(state.ui.scope, state.ui.targetId)) renderCenter();
    }
  }

  function applyMessageEdit(m) {
    const scope = m.scope;
    const targetId = m.targetId || (scope === "dm" ? m.peerId : scope === "group" ? m.groupId : null);
    const th = getThread(scope, targetId);
    if (!th?.messages) return;
    const idx = th.messages.findIndex((x) => x.id === m.id);
    if (idx >= 0) {
      th.messages[idx] = { ...th.messages[idx], ...m };
      if (isCurrentThread(scope, targetId)) renderCenter();
    }
  }

  function applyMessageDelete(messageId, scope, targetId) {
    const th = getThread(scope, targetId);
    if (!th?.messages) return;
    const idx = th.messages.findIndex((x) => x.id === messageId);
    if (idx >= 0) {
      th.messages.splice(idx, 1);
      if (isCurrentThread(scope, targetId)) renderCenter();
    }
  }

  /* -----------------------------
     Typing
  ----------------------------- */

  let typingTimer = null;

  function emitTyping(isTyping) {
    const { scope, targetId } = currentScopeForSend();
    if (!scope || !state.socket) return;
    state.socket.emit("typing", { scope, targetId, typing: !!isTyping });
  }

  function updateTypingUi(payload) {
    if (!payload || !dom.typingText) return;
    const scope = payload.scope;
    const targetId = payload.targetId || null;

    if (!isCurrentThread(scope, targetId)) return;

    const users = Array.isArray(payload.users) ? payload.users : [];
    const names = users
      .filter((u) => u?.username && u.username !== state.session.user?.username)
      .slice(0, 3)
      .map((u) => u.username);

    if (!names.length) {
      dom.typingText.textContent = "";
      return;
    }

    dom.typingText.textContent = `${names.join(", ")} typing…`;
    state.ui.typing.lastUpdateAt = Date.now();

    setTimeout(() => {
      if (Date.now() - state.ui.typing.lastUpdateAt > 2500) dom.typingText.textContent = "";
    }, 2600);
  }

  /* -----------------------------
     Read markers + jump
  ----------------------------- */

    function emitRead(scope, targetId, messageId) {
    if (!messageId || !state.socket) return;

    // Update local last-read
    if (scope === "global") state.ui.lastRead.global = messageId;
    else if (scope === "dm" && targetId) state.ui.lastRead.dm[targetId] = messageId;
    else if (scope === "group" && targetId) state.ui.lastRead.group[targetId] = messageId;

    state.socket.emit("read", { scope, targetId, messageId, ts: Date.now() });
  }

  function applyReadUpdate(payload) {
    // Server may also update per-message readCount via message:edit.
    // We keep local markers only; display updates arrive through edits.
    // Optionally, you could store other users' read pointers here.
  }

  function jumpToLastRead() {
    const scope = state.ui.scope;
    const targetId = state.ui.targetId;

    let msgId = null;
    if (scope === "global") msgId = state.ui.lastRead.global;
    else if (scope === "dm" && targetId) msgId = state.ui.lastRead.dm[targetId] || null;
    else if (scope === "group" && targetId) msgId = state.ui.lastRead.group[targetId] || null;

    if (!dom.centerBody) return;

    if (!msgId) {
      dom.centerBody.scrollTop = dom.centerBody.scrollHeight;
      return;
    }

    const node = $(`.msg[data-id="${CSS.escape(msgId)}"]`, dom.centerBody);
    if (node) {
      node.scrollIntoView({
        block: "center",
        behavior: state.settings.accessibility.reducedMotion ? "auto" : "smooth",
      });
      node.style.borderColor = "rgba(142,162,255,.35)";
      setTimeout(() => (node.style.borderColor = ""), 900);
    } else {
      dom.centerBody.scrollTop = dom.centerBody.scrollHeight;
    }
  }

  /* -----------------------------
     Right panels
  ----------------------------- */

  function renderGlobalInfo() {
    if (!dom.rightBody) return;

    dom.rightBody.innerHTML = `
      <div class="card">
        <h3>Rules</h3>
        <p>Global is auto-moderated. Right-click a message to report it.</p>
        <div class="kv"><span>Mode</span><b>AUTO-MOD</b></div>
      </div>

      <div class="card">
        <h3>Presence</h3>
        <div class="list">
          <div class="mini" id="pOnline"><div class="left"><div class="t">Online</div><div class="d">Default</div></div><span class="badge">SET</span></div>
          <div class="mini" id="pIdle"><div class="left"><div class="t">Idle</div><div class="d">Away</div></div><span class="badge">SET</span></div>
          <div class="mini" id="pDnd"><div class="left"><div class="t">DND</div><div class="d">Do not disturb</div></div><span class="badge">SET</span></div>
          <div class="mini" id="pInv"><div class="left"><div class="t">Invisible</div><div class="d">Appear offline</div></div><span class="badge">SET</span></div>
        </div>
      </div>

      <div class="card">
        <h3>Online</h3>
        <div class="kv"><span>Users</span><b>${escapeHtml(String(state.data.onlineCount || 0))}</b></div>
      </div>
    `;

    $("#pOnline")?.addEventListener("click", () => setPresence("online"));
    $("#pIdle")?.addEventListener("click", () => setPresence("idle"));
    $("#pDnd")?.addEventListener("click", () => setPresence("dnd"));
    $("#pInv")?.addEventListener("click", () => setPresence("invisible"));
  }

  function renderFriendsPanel() {
    if (!dom.rightBody) return;

    const friends = state.data.dms.friends || [];
    const threads = state.data.dms.threads || {};

    const rows = friends
      .map((f) => {
        const th = threads[f.id];
        const last = th?.messages?.[th.messages.length - 1];
        const preview = last ? safeText(last.text).slice(0, 48) : "No messages yet";
        return `
          <div class="mini" data-peer="${escapeHtml(f.id)}">
            <div class="left">
              <div class="t">${escapeHtml(f.username || "User")}</div>
              <div class="d">${escapeHtml(preview)}</div>
            </div>
            <span class="badge">DM</span>
          </div>
        `;
      })
      .join("");

    dom.rightBody.innerHTML = `
      <div class="card">
        <h3>Friends</h3>
        <p>Friends show up here as DM entries.</p>
      </div>

      <div class="card">
        <h3>Open DM</h3>
        <div class="list" id="friendList">
          ${rows || `<div class="small">No friends yet.</div>`}
        </div>
      </div>
    `;

    $$("#friendList .mini").forEach((n) => {
      n.addEventListener("click", () => {
        const peer = n.getAttribute("data-peer");
        if (peer) openDm(peer);
      });
    });
  }

  async function openDm(peerId) {
    state.ui.scope = "dm";
    state.ui.targetId = peerId;

    if (!state.data.dms.threads[peerId]) {
      const f =
        (state.data.dms.friends || []).find((x) => x.id === peerId) || {
          id: peerId,
          username: "User",
        };
      state.data.dms.threads[peerId] = {
        peer: f,
        messages: [],
        cursor: null,
        hasMore: true,
        lastRead: null,
      };
    }

    if (state.socket) state.socket.emit("dm:open", { peerId });

    const th = state.data.dms.threads[peerId];
    if (th.messages.length === 0) {
      state.ui.skeleton = true;
      renderSkeletonCenter(5);

      try {
        const resp = await api(`/api/messages/dm/${encodeURIComponent(peerId)}?limit=50`, { method: "GET" });
        if (resp?.ok) {
          th.messages = Array.isArray(resp.messages) ? resp.messages : [];
          th.cursor = resp.cursor ?? null;
          th.hasMore = resp.hasMore ?? true;
          if (resp.peer) th.peer = resp.peer;
        }
      } catch (e) {
        console.warn(e);
      } finally {
        state.ui.skeleton = false;
      }
    }

    render();
  }

  function renderGroupsPanel() {
    if (!dom.rightBody) return;

    const groups = state.data.groups.list || [];
    const rows = groups
      .map((g) => {
        const th = state.data.groups.threads[g.id];
        const last = th?.messages?.[th.messages.length - 1];
        const preview = last ? safeText(last.text).slice(0, 48) : "No messages yet";
        const lim = typeof g.limit === "number" ? `limit ${g.limit}` : `limit —`;
        const badge = g.ownerId && state.session.user?.id && g.ownerId === state.session.user.id ? "OWNER" : "GC";
        return `
          <div class="mini" data-group="${escapeHtml(g.id)}">
            <div class="left">
              <div class="t">${escapeHtml(g.name || "Group Chat")}</div>
              <div class="d">${escapeHtml(preview)} • ${escapeHtml(lim)}</div>
            </div>
            <span class="badge">${escapeHtml(badge)}</span>
          </div>
        `;
      })
      .join("");

    dom.rightBody.innerHTML = `
      <div class="card">
        <h3>Group Chats</h3>
        <p>Invite-only by owner.</p>
      </div>

      <div class="card">
        <h3>Select</h3>
        <div class="list" id="groupList">
          ${rows || `<div class="small">No group chats yet.</div>`}
        </div>
      </div>

      <div class="card">
        <h3>Owner tools</h3>
        <div class="list">
          <div class="mini" id="gcManage">
            <div class="left"><div class="t">Manage selected</div><div class="d">Name, limit, cooldown, invites</div></div>
            <span class="badge">TOOLS</span>
          </div>
        </div>
      </div>
    `;

    $$("#groupList .mini").forEach((n) => {
      n.addEventListener("click", () => {
        const gid = n.getAttribute("data-group");
        if (gid) openGroup(gid);
      });
    });

    $("#gcManage")?.addEventListener("click", openGroupManage);
  }

  async function openGroup(groupId) {
    state.ui.scope = "group";
    state.ui.targetId = groupId;

    if (!state.data.groups.threads[groupId]) {
      const g = (state.data.groups.list || []).find((x) => x.id === groupId) || {
        id: groupId,
        name: "Group Chat",
      };
      state.data.groups.threads[groupId] = {
        info: g,
        messages: [],
        cursor: null,
        hasMore: true,
        lastRead: null,
      };
    }

    if (state.socket) state.socket.emit("groups:join", { groupId });

    const th = state.data.groups.threads[groupId];
    if (th.messages.length === 0) {
      state.ui.skeleton = true;
      renderSkeletonCenter(6);

      try {
        const resp = await api(`/api/messages/group/${encodeURIComponent(groupId)}?limit=60`, { method: "GET" });
        if (resp?.ok) {
          th.messages = Array.isArray(resp.messages) ? resp.messages : [];
          th.cursor = resp.cursor ?? null;
          th.hasMore = resp.hasMore ?? true;
          if (resp.group) th.info = resp.group;
        }
      } catch (e) {
        console.warn(e);
      } finally {
        state.ui.skeleton = false;
      }
    }

    render();
  }

  function renderWhatsNew() {
    if (!dom.centerBody) return;
    const items = state.data.whatsNew || [];

    if (!items.length) {
      dom.centerBody.innerHTML = `
        <div class="card">
          <h3>No updates</h3>
          <p>When updates exist, they can include cropped images + try actions.</p>
        </div>
      `;
      return;
    }

    dom.centerBody.innerHTML = items
      .map((it, idx) => {
        const title = escapeHtml(it.title || `Update ${idx + 1}`);
        const desc = escapeHtml(it.desc || "");
        const img = it.image
          ? `<div style="margin-top:10px;border:1px solid var(--stroke);border-radius:16px;overflow:hidden;background:rgba(0,0,0,.25)">
               <img src="${escapeHtml(it.image)}" alt="" style="width:100%;height:160px;object-fit:cover;display:block;">
             </div>`
          : "";
        const tryKey = escapeHtml(it.tryKey || "");
        return `
          <div class="card" data-try="${tryKey}">
            <h3>${title}</h3>
            <p>${desc}</p>
            ${img}
            <div class="kv"><span>Try</span><b>${tryKey ? "available" : "—"}</b></div>
          </div>
        `;
      })
      .join("");

    $$(".card[data-try]", dom.centerBody).forEach((c) => {
      c.addEventListener("click", () => {
        const key = c.getAttribute("data-try");
        if (!key) return;

        openModal(
          "Try feature",
          `<div class="small">Triggers server preview hook for <b>${escapeHtml(key)}</b>.</div>`,
          [
            { label: "Cancel", onClick: closeModal },
            {
              label: "Try",
              kind: "primary",
              onClick: async () => {
                await api("/api/content/try", { method: "POST", body: { key } }).catch(() => {});
                closeModal();
              },
            },
          ]
        );
      });
    });
  }

  function renderWhatsNewPanel() {
    if (!dom.rightBody) return;
    dom.rightBody.innerHTML = `
      <div class="card">
        <h3>Preview</h3>
        <p>Updates can include images + “Try”.</p>
      </div>
    `;
  }

  function renderSettings() {
    if (!dom.centerBody) return;
    const s = state.settings;
    const prof = clamp(s.filters.profanityLevel, 0, 2);

    dom.centerBody.innerHTML = `
      <div class="card">
        <h3>Accessibility</h3>
        <div class="list">
          <label class="mini" style="cursor:default">
            <div class="left"><div class="t">Reduced motion</div><div class="d">Minimize animations</div></div>
            <input type="checkbox" id="setReduced" ${s.accessibility.reducedMotion ? "checked" : ""} />
          </label>
          <label class="mini" style="cursor:default">
            <div class="left"><div class="t">High contrast</div><div class="d">Sharper text and borders</div></div>
            <input type="checkbox" id="setContrast" ${s.accessibility.highContrast ? "checked" : ""} />
          </label>
          <label class="mini" style="cursor:default">
            <div class="left"><div class="t">Focus rings</div><div class="d">Keyboard focus outlines</div></div>
            <input type="checkbox" id="setFocus" ${s.accessibility.focusRings ? "checked" : ""} />
          </label>
        </div>
      </div>

      <div class="card">
        <h3>Sound</h3>
        <div class="list">
          <label class="mini" style="cursor:default">
            <div class="left"><div class="t">Enable sound</div><div class="d">Message pings</div></div>
            <input type="checkbox" id="setSound" ${s.sound.enabled ? "checked" : ""} />
          </label>
          <div class="mini" style="cursor:default">
            <div class="left"><div class="t">Volume</div><div class="d">0 to 100</div></div>
            <input type="range" id="setVol" min="0" max="100" value="${Math.round(clamp(s.sound.volume, 0, 1) * 100)}" />
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Cursor</h3>
        <div class="list">
          <label class="mini" style="cursor:default">
            <div class="left"><div class="t">Custom cursor</div><div class="d">Enabled by default</div></div>
            <input type="checkbox" id="setCursor" ${s.cursor.enabled ? "checked" : ""} />
          </label>
          <div class="mini" style="cursor:default">
            <div class="left"><div class="t">Size</div><div class="d">Bigger is easier</div></div>
            <input type="range" id="setCurSize" min="90" max="190" value="${Math.round(clamp(s.cursor.size, 0.9, 1.9) * 100)}" />
          </div>
          <label class="mini" style="cursor:default">
            <div class="left"><div class="t">Dynamic</div><div class="d">Grows on hover</div></div>
            <input type="checkbox" id="setCurDyn" ${s.cursor.dynamic ? "checked" : ""} />
          </label>
        </div>
      </div>

      <div class="card">
        <h3>Font</h3>
        <div class="list">
          <div class="mini" style="cursor:default">
            <div class="left"><div class="t">Font size</div><div class="d">90–130</div></div>
            <input type="range" id="setFont" min="90" max="130" value="${Math.round(clamp(s.fontScale, 0.9, 1.3) * 100)}" />
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Filters</h3>
        <div class="list">
          <label class="mini" style="cursor:default">
            <div class="left"><div class="t">Block mild profanity in Global</div><div class="d">Stricter language</div></div>
            <input type="checkbox" id="setGlobalProf" ${s.filters.globalProfanityBlock ? "checked" : ""} />
          </label>

          <div class="mini" style="cursor:default">
            <div class="left"><div class="t">DM/Group profanity</div><div class="d">0 none • 1 mild • 2 strict</div></div>
            <input type="range" id="setProf" min="0" max="2" step="1" value="${prof}" />
          </div>

          <label class="mini" style="cursor:default">
            <div class="left"><div class="t">Block 18+ in DM/Group</div><div class="d">Recommended</div></div>
            <input type="checkbox" id="setAdult" ${s.filters.adultBlock ? "checked" : ""} />
          </label>
        </div>
      </div>
    `;

    $("#setReduced")?.addEventListener("change", async (e) => {
      state.settings.accessibility.reducedMotion = !!e.target.checked;
      await saveSettingsToServer();
    });
    $("#setContrast")?.addEventListener("change", async (e) => {
      state.settings.accessibility.highContrast = !!e.target.checked;
      await saveSettingsToServer();
    });
    $("#setFocus")?.addEventListener("change", async (e) => {
      state.settings.accessibility.focusRings = !!e.target.checked;
      await saveSettingsToServer();
    });

    $("#setSound")?.addEventListener("change", async (e) => {
      state.settings.sound.enabled = !!e.target.checked;
      await saveSettingsToServer();
      beep("recv");
    });
    $("#setVol")?.addEventListener("input", (e) => {
      state.settings.sound.volume = clamp(Number(e.target.value) / 100, 0, 1);
      saveSettingsToLocal();
    });
    $("#setVol")?.addEventListener("change", async () => {
      await saveSettingsToServer();
      beep("send");
    });

    $("#setCursor")?.addEventListener("change", async (e) => {
      state.settings.cursor.enabled = !!e.target.checked;
      await saveSettingsToServer();
    });
    $("#setCurSize")?.addEventListener("input", (e) => {
      state.settings.cursor.size = clamp(Number(e.target.value) / 100, 0.9, 1.9);
      saveSettingsToLocal();
    });
    $("#setCurSize")?.addEventListener("change", async () => {
      await saveSettingsToServer();
    });
    $("#setCurDyn")?.addEventListener("change", async (e) => {
      state.settings.cursor.dynamic = !!e.target.checked;
      await saveSettingsToServer();
    });

    $("#setFont")?.addEventListener("input", (e) => {
      state.settings.fontScale = clamp(Number(e.target.value) / 100, 0.9, 1.3);
      applySettingsToDom();
      saveSettingsToLocal();
    });
    $("#setFont")?.addEventListener("change", async () => {
      await saveSettingsToServer();
    });

    $("#setGlobalProf")?.addEventListener("change", async (e) => {
      state.settings.filters.globalProfanityBlock = !!e.target.checked;
      await saveSettingsToServer();
    });
    $("#setProf")?.addEventListener("input", (e) => {
      state.settings.filters.profanityLevel = clamp(Number(e.target.value), 0, 2);
      saveSettingsToLocal();
    });
    $("#setProf")?.addEventListener("change", async () => {
      await saveSettingsToServer();
    });
    $("#setAdult")?.addEventListener("change", async (e) => {
      state.settings.filters.adultBlock = !!e.target.checked;
      await saveSettingsToServer();
    });
  }

  function renderAccountPanel() {
    if (!dom.rightBody) return;
    const u = state.session.user || {};
    dom.rightBody.innerHTML = `
      <div class="card">
        <h3>Account</h3>
        <div class="kv"><span>User</span><b>${escapeHtml(u.username || "user")}</b></div>
      </div>

      <div class="card">
        <h3>Session</h3>
        <div class="list">
          <div class="mini" id="actSync">
            <div class="left"><div class="t">Sync settings</div><div class="d">Pull from server</div></div>
            <span class="badge">SYNC</span>
          </div>
          <div class="mini" id="actLogout">
            <div class="left"><div class="t">Log out</div><div class="d">End session</div></div>
            <span class="badge">OUT</span>
          </div>
        </div>
      </div>
    `;

    $("#actSync")?.addEventListener("click", async () => {
      showLoading("Syncing…", "sync");
      await syncSettingsFromServer().catch(() => {});
      hideLoading();
      render();
    });
    $("#actLogout")?.addEventListener("click", doLogout);
  }

  /* -----------------------------
     User card
  ----------------------------- */

  function openUserCard(user) {
    const u = user || {};
    const name = escapeHtml(u.username || "user");
    const id = escapeHtml(u.id || "—");
    const badges = Array.isArray(u.badges) ? u.badges : [];
    const badgeHtml = badges.map((b) => `<span class="ub">${escapeHtml(String(b).slice(0, 16))}</span>`).join("") || `<span class="ub gray">none</span>`;

    openModal(
      `User • ${name}`,
      `
        <div class="card" style="margin:0">
          <h3>${name}</h3>
          <div class="kv"><span>ID</span><b>${id}</b></div>
          <div class="kv"><span>Badges</span><b>${badgeHtml}</b></div>
        </div>
      `,
      [{ label: "Close", kind: "primary", onClick: closeModal }]
    );
  }

  /* -----------------------------
     Group manage modal (owner tools UI hook)
  ----------------------------- */

  function openGroupManage() {
    const gid = state.ui.scope === "group" ? state.ui.targetId : null;
    const th = gid ? state.data.groups.threads[gid] : null;
    const g = th?.info || (gid ? state.data.groups.list.find((x) => x.id === gid) : null);

    if (!g) {
      openModal("Manage group", `<div class="small">Select a group chat first.</div>`, [{ label: "OK", kind: "primary", onClick: closeModal }]);
      return;
    }

    const isOwner = g.ownerId && state.session.user?.id && g.ownerId === state.session.user.id;

    openModal(
      `Manage • ${escapeHtml(g.name || "Group Chat")}`,
      `
        <div class="small">Owner-only actions are enforced by the server.</div>

        <div class="card" style="margin:0">
          <h3>Info panel</h3>
          <p>${escapeHtml(g.rules || "No rules set yet.")}</p>
          <div class="kv"><span>Limit</span><b>${escapeHtml(String(g.limit ?? "—"))}</b></div>
          <div class="kv"><span>Cooldown</span><b>${escapeHtml(String(g.cooldownSeconds ?? 0))}s</b></div>
        </div>

        <div class="card" style="margin:0">
          <h3>Update</h3>
          <input id="gName" class="input" placeholder="Name" value="${escapeHtml(g.name || "")}" />
          <input id="gLimit" class="input" placeholder="Member limit" value="${escapeHtml(String(g.limit ?? ""))}" />
          <input id="gCooldown" class="input" placeholder="Cooldown seconds" value="${escapeHtml(String(g.cooldownSeconds ?? 0))}" />
          <input id="gRules" class="input" placeholder="Rules / info panel text" value="${escapeHtml(g.rules || "")}" />
        </div>

        <div class="card" style="margin:0">
          <h3>Invite link</h3>
          <button class="btn" id="btnInviteLink" ${isOwner ? "" : "disabled"}>Create invite link</button>
        </div>
      `,
      [
        { label: "Close", onClick: closeModal },
        {
          label: "Save",
          kind: "primary",
          onClick: async () => {
            if (!isOwner) {
              beep("err");
              return;
            }
            const name = $("#gName")?.value ?? "";
            const limit = Number($("#gLimit")?.value ?? "");
            const cooldownSeconds = Number($("#gCooldown")?.value ?? "0");
            const rules = $("#gRules")?.value ?? "";
            await updateGroup(g.id, { name, limit, cooldownSeconds, rules });
            closeModal();
          },
        },
      ]
    );

    $("#btnInviteLink")?.addEventListener("click", async () => {
      if (!isOwner) return;
      try {
        const resp = await api("/api/groups/inviteLink", { method: "POST", body: { groupId: g.id } });
        if (resp?.ok && resp.link) {
          openModal(
            "Invite link",
            `<div class="small">Share this link. Owner approval/add happens server-side.</div>
             <input class="input" value="${escapeHtml(resp.link)}" onclick="this.select()" />`,
            [{ label: "OK", kind: "primary", onClick: closeModal }]
          );
        }
      } catch (e) {
        beep("err");
      }
    });
  }

  async function updateGroup(groupId, patch) {
    try {
      const resp = await api("/api/groups/update", { method: "POST", body: { groupId, patch } });
      if (resp?.ok && resp.group) {
        const idx = state.data.groups.list.findIndex((x) => x.id === groupId);
        if (idx >= 0) state.data.groups.list[idx] = resp.group;
        if (state.data.groups.threads[groupId]) state.data.groups.threads[groupId].info = resp.group;
        render();
      }
    } catch (e) {
      beep("err");
      openModal("Group update failed", `<div class="warn">${escapeHtml(e.message || "failed")}</div>`, [{ label: "OK", kind: "primary", onClick: closeModal }]);
    }
  }

  /* -----------------------------
     Refresh + pagination
  ----------------------------- */

  async function refreshCurrent() {
    const tab = state.ui.tab;

    if (tab === "global") {
      state.ui.skeleton = true;
      renderSkeletonCenter(6);
      try {
        const resp = await api(`/api/messages/global?limit=80`, { method: "GET" });
        if (resp?.ok) {
          state.data.global.messages = Array.isArray(resp.messages) ? resp.messages : [];
          state.data.global.cursor = resp.cursor ?? null;
          state.data.global.hasMore = resp.hasMore ?? true;
        }
      } catch (e) {
        console.warn(e);
      } finally {
        state.ui.skeleton = false;
        render();
      }
      return;
    }

    if (tab === "messages" && state.ui.scope === "dm" && state.ui.targetId) {
      state.ui.skeleton = true;
      renderSkeletonCenter(6);
      try {
        const peerId = state.ui.targetId;
        const resp = await api(`/api/messages/dm/${encodeURIComponent(peerId)}?limit=80`, { method: "GET" });
        if (resp?.ok) {
          const th =
            state.data.dms.threads[peerId] ||
            (state.data.dms.threads[peerId] = {
              peer: { id: peerId, username: "User" },
              messages: [],
              cursor: null,
              hasMore: true,
              lastRead: null,
            });
          th.messages = Array.isArray(resp.messages) ? resp.messages : [];
          th.cursor = resp.cursor ?? null;
          th.hasMore = resp.hasMore ?? true;
          if (resp.peer) th.peer = resp.peer;
        }
      } catch (e) {
        console.warn(e);
      } finally {
        state.ui.skeleton = false;
        render();
      }
      return;
    }

    if (tab === "groups" && state.ui.scope === "group" && state.ui.targetId) {
      state.ui.skeleton = true;
      renderSkeletonCenter(7);
      try {
        const gid = state.ui.targetId;
        const resp = await api(`/api/messages/group/${encodeURIComponent(gid)}?limit=90`, { method: "GET" });
        if (resp?.ok) {
          const th =
            state.data.groups.threads[gid] ||
            (state.data.groups.threads[gid] = {
              info: { id: gid, name: "Group Chat" },
              messages: [],
              cursor: null,
              hasMore: true,
              lastRead: null,
            });
          th.messages = Array.isArray(resp.messages) ? resp.messages : [];
          th.cursor = resp.cursor ?? null;
          th.hasMore = resp.hasMore ?? true;
          if (resp.group) th.info = resp.group;
        }
      } catch (e) {
        console.warn(e);
      } finally {
        state.ui.skeleton = false;
        render();
      }
      return;
    }

    // whatsnew/settings: lightweight full refresh
    showLoading("Refreshing…", "refresh");
    await bootstrap();
    hideLoading();
    render();
  }

  async function loadOlder() {
    const scope = state.ui.scope;
    const targetId = state.ui.targetId;

    const th = getThread(scope, targetId);
    if (!th || !th.hasMore) return;
    if (!dom.centerBody) return;

    const prevHeight = dom.centerBody.scrollHeight;
    const prevTop = dom.centerBody.scrollTop;

    try {
      if (scope === "global") {
        const before = th.cursor || th.messages?.[0]?.id || "";
        const resp = await api(`/api/messages/global?before=${encodeURIComponent(before)}&limit=60`, { method: "GET" });
        if (resp?.ok) {
          const older = Array.isArray(resp.messages) ? resp.messages : [];
          th.messages = older.concat(th.messages);
          th.cursor = resp.cursor ?? th.cursor;
          th.hasMore = resp.hasMore ?? th.hasMore;
        }
      } else if (scope === "dm" && targetId) {
        const before = th.cursor || th.messages?.[0]?.id || "";
        const resp = await api(`/api/messages/dm/${encodeURIComponent(targetId)}?before=${encodeURIComponent(before)}&limit=60`, { method: "GET" });
        if (resp?.ok) {
          const older = Array.isArray(resp.messages) ? resp.messages : [];
          th.messages = older.concat(th.messages);
          th.cursor = resp.cursor ?? th.cursor;
          th.hasMore = resp.hasMore ?? th.hasMore;
        }
      } else if (scope === "group" && targetId) {
        const before = th.cursor || th.messages?.[0]?.id || "";
        const resp = await api(`/api/messages/group/${encodeURIComponent(targetId)}?before=${encodeURIComponent(before)}&limit=70`, { method: "GET" });
        if (resp?.ok) {
          const older = Array.isArray(resp.messages) ? resp.messages : [];
          th.messages = older.concat(th.messages);
          th.cursor = resp.cursor ?? th.cursor;
          th.hasMore = resp.hasMore ?? th.hasMore;
        }
      }
    } catch (e) {
      console.warn("loadOlder failed:", e.message);
    }

    renderCenter();

    setTimeout(() => {
      const newHeight = dom.centerBody.scrollHeight;
      const delta = newHeight - prevHeight;
      dom.centerBody.scrollTop = prevTop + delta;
    }, 0);
  }

  let scrollLoadLock = false;
  dom.centerBody?.addEventListener("scroll", async () => {
    if (state.ui.skeleton) return;
    if (scrollLoadLock) return;
    if (!dom.centerBody) return;
    if (dom.centerBody.scrollTop <= 12) {
      scrollLoadLock = true;
      await loadOlder();
      scrollLoadLock = false;
    }
  });

  /* -----------------------------
     Composer events
  ----------------------------- */

  dom.btnSend?.addEventListener("click", () => {
    sendMessage(dom.msgInput?.value || "");
  });

  dom.msgInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(dom.msgInput.value);
    }
  });

  dom.msgInput?.addEventListener("input", () => {
    if (typingTimer) clearTimeout(typingTimer);
    emitTyping(true);
    typingTimer = setTimeout(() => emitTyping(false), 850);
  });

  /* -----------------------------
     Buttons / nav
  ----------------------------- */

  dom.btnLogout?.addEventListener("click", doLogout);
  dom.btnJumpLastRead?.addEventListener("click", jumpToLastRead);
  dom.btnRefresh?.addEventListener("click", refreshCurrent);

  (dom.navItems || []).forEach((it) => {
    it.addEventListener("click", () => {
      const tab = it.getAttribute("data-tab");
      if (tab) setTab(tab);
    });
  });

  dom.btnUser?.addEventListener("click", () => {
    openUserCard(state.session.user || {});
  });

  dom.btnRightAction?.addEventListener("click", () => {
    if (state.ui.tab === "global") {
      openModal(
        "Rules",
        `<div class="small">Global is auto-moderated. Right-click messages to report.</div>`,
        [{ label: "OK", kind: "primary", onClick: closeModal }]
      );
      return;
    }

    if (state.ui.tab === "messages") {
      openModal(
        "Add friend",
        `<div class="small">Friend add flow is server-driven.</div>
         <input id="friendName" class="input" placeholder="username" />`,
        [
          { label: "Cancel", onClick: closeModal },
          {
            label: "Request",
            kind: "primary",
            onClick: async () => {
              const username = $("#friendName")?.value?.trim() || "";
              if (!username) return;
              await api("/api/friends/request", { method: "POST", body: { username } }).catch(() => {});
              closeModal();
              await refreshCurrent();
            },
          },
        ]
      );
      return;
    }

    if (state.ui.tab === "groups") {
      openModal(
        "Create group chat",
        `<div class="small">Invite-only by owner.</div>
         <input id="cgName" class="input" placeholder="Group name" />
         <input id="cgLimit" class="input" placeholder="Member limit (e.g. 10)" />
         <input id="cgCooldown" class="input" placeholder="Cooldown seconds (e.g. 2)" />`,
        [
          { label: "Cancel", onClick: closeModal },
          {
            label: "Create",
            kind: "primary",
            onClick: async () => {
              const name = $("#cgName")?.value?.trim() || "Group Chat";
              const limit = Number($("#cgLimit")?.value || 10);
              const cooldownSeconds = Number($("#cgCooldown")?.value || 2);
              try {
                const resp = await api("/api/groups/create", { method: "POST", body: { name, limit, cooldownSeconds } });
                closeModal();
                if (resp?.ok && resp.group?.id) {
                  state.data.groups.list.unshift(resp.group);
                  await openGroup(resp.group.id);
                } else {
                  await refreshCurrent();
                }
              } catch (e) {
                beep("err");
              }
            },
          },
        ]
      );
      return;
    }

    if (state.ui.tab === "whatsnew") {
      openModal("What’s New", `<div class="small">Click an update card to “Try”.</div>`, [{ label: "OK", kind: "primary", onClick: closeModal }]);
      return;
    }

    if (state.ui.tab === "settings") {
      openModal(
        "Session",
        `<div class="small">Sync pulls settings from server; log out ends the session.</div>`,
        [
          {
            label: "Sync",
            kind: "primary",
            onClick: async () => {
              closeModal();
              showLoading("Syncing…", "sync");
              await syncSettingsFromServer().catch(() => {});
              hideLoading();
              render();
            },
          },
          { label: "Log out", kind: "danger", onClick: async () => { closeModal(); await doLogout(); } },
        ]
      );
    }
  });

  /* -----------------------------
     Login wiring
  ----------------------------- */

  dom.btnLogin?.addEventListener("click", () => {
    const u = (dom.loginUser?.value || "").trim();
    const p = dom.loginPass?.value || "";
    if (!u || !p) {
      setLoginMessage("Enter username and password.", true);
      return;
    }
    doLogin(u, p);
  });

  dom.btnGuest?.addEventListener("click", () => {
    doGuest();
  });

  dom.loginPass?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") dom.btnLogin?.click();
  });

  dom.loginUser?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") dom.loginPass?.focus();
  });

  /* -----------------------------
     Dynamic custom cursor
  ----------------------------- */

  const cursorState = {
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    tx: window.innerWidth / 2,
    ty: window.innerHeight / 2,
    vx: 0,
    vy: 0,
    over: false,
    down: false,
    lastMove: 0,
  };

  function setCursorScale(scale) {
    if (!dom.cursor) return;
    dom.cursor.style.transform = `translate(${cursorState.x}px, ${cursorState.y}px) translate(-50%, -50%) scale(${scale})`;
  }

  function setTrailPos(x, y, a = 1) {
    if (!dom.trail) return;
    dom.trail.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    dom.trail.style.opacity = String(a);
  }

  document.addEventListener("mousemove", (e) => {
    cursorState.tx = e.clientX;
    cursorState.ty = e.clientY;
    cursorState.lastMove = Date.now();
  });

  document.addEventListener("mousedown", () => (cursorState.down = true));
  document.addEventListener("mouseup", () => (cursorState.down = false));

  document.addEventListener("mouseover", (e) => {
    const t = e.target;
    cursorState.over = !!(
      t &&
      (t.closest("button") ||
        t.closest("a") ||
        t.closest("input") ||
        t.closest("textarea") ||
        t.closest(".mini") ||
        t.closest(".nav-item"))
    );
  });

  function cursorTick() {
    if (!state.settings.cursor.enabled) {
      requestAnimationFrame(cursorTick);
      return;
    }

    const s = state.settings.cursor.size || 1.35;
    const dynamic = !!state.settings.cursor.dynamic;

    const dx = cursorState.tx - cursorState.x;
    const dy = cursorState.ty - cursorState.y;

    cursorState.vx = (cursorState.vx + dx * 0.18) * 0.62;
    cursorState.vy = (cursorState.vy + dy * 0.18) * 0.62;

    cursorState.x += cursorState.vx;
    cursorState.y += cursorState.vy;

    let scale = s;
    if (dynamic) {
      if (cursorState.over) scale *= 1.18;
      if (cursorState.down) scale *= 0.88;
      const idle = Math.min(1, (Date.now() - cursorState.lastMove) / 2500);
      scale *= 1 + idle * 0.06 * Math.sin(Date.now() / 420);
    }

    setCursorScale(scale);

    const tx = cursorState.x - cursorState.vx * 1.6;
    const ty = cursorState.y - cursorState.vy * 1.6;
    const speed = Math.min(1, Math.hypot(cursorState.vx, cursorState.vy) / 22);
    const op = dynamic ? 0.18 + speed * 0.35 : 0.22;
    setTrailPos(tx, ty, op);

    requestAnimationFrame(cursorTick);
  }
  requestAnimationFrame(cursorTick);

  /* -----------------------------
     Keyboard helpers
  ----------------------------- */

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.ui.context.open) closeContextMenu();
      if (dom.backdrop?.classList.contains("show")) closeModal();
    }
  });

  /* -----------------------------
     Warm start
  ----------------------------- */

  async function warmStart() {
    loadSettingsFromLocal();

    // If token exists, attempt resume
    if (state.session.token) {
      showApp();
      showLoading("Restoring session…", "resume");
      try {
        const me = await api("/api/users/me", { method: "GET" });
        if (me?.ok && me.user) {
          state.session.user = me.user;
          localSet("tk_user", state.session.user);
          await sleep(180);
          await afterAuthBoot();
          return;
        }
      } catch (e) {
        console.warn("resume failed:", e.message);
      }

      // invalid token -> clear
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

  window.addEventListener("error", (e) => console.warn("window error:", e?.message));
  window.addEventListener("unhandledrejection", (e) => console.warn("unhandled rejection:", e?.reason?.message || e?.reason));

  /* -----------------------------
     Start
  ----------------------------- */

  warmStart();
})();
