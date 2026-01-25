/* public/script.js — tonkotsu.online client
   - Works with server.js in this chat (REST auth + Socket.IO global)
   - Keeps legacy event compatibility where possible
   - Implements:
     • login/create (first login creates account)
     • guest login
     • global chat (public + logged on server)
     • link rules (client-side hint; server enforces)
     • cooldown UX
     • minimal UI wiring (expects existing HTML structure)
*/

(() => {
  "use strict";

  /* ------------------------------ Config ------------------------------ */

  const API = ""; // same-origin
  const LS_TOKEN = "tk_token";
  const LS_USER = "tk_user";
  const LS_GUEST = "tk_guest";

  // Client-side helper only; server is source of truth
  const LINK_COOLDOWN_MS = 5 * 60 * 1000;

  /* ------------------------------ DOM ------------------------------ */

  const $ = (sel) => document.querySelector(sel);

  // Auth modal / fields (adjust selectors if your HTML differs)
  const elLoginModal = $("#loginModal") || $("#authModal") || null;
  const elUsername = $("#username") || $("#loginUsername") || null;
  const elPassword = $("#password") || $("#loginPassword") || null;
  const elLoginBtn = $("#loginBtn") || $("#btnLogin") || null;
  const elGuestBtn = $("#guestBtn") || $("#btnGuest") || null;
  const elLogoutBtn = $("#logoutBtn") || $("#btnLogout") || null;
  const elLoginMsg = $("#loginMsg") || $("#authMsg") || null;

  // Global chat
  const elGlobalList = $("#globalMessages") || $("#globalList") || $("#messages") || null;
  const elGlobalInput = $("#globalInput") || $("#messageInput") || null;
  const elGlobalSend = $("#globalSend") || $("#sendBtn") || null;
  const elOnlineCount = $("#onlineCount") || $("#online") || null;

  // User header
  const elMeName = $("#meName") || $("#currentUser") || null;
  const elMeBadge = $("#meBadge") || $("#badge") || null;

  /* ------------------------------ State ------------------------------ */

  let socket = null;
  let token = localStorage.getItem(LS_TOKEN) || "";
  let currentUser = localStorage.getItem(LS_USER) || "";
  let isGuest = localStorage.getItem(LS_GUEST) === "1";

  // Simple client-side link cooldown tracking (server enforces)
  let lastLinkAt = 0;

  // UI cooldown state
  let cooldownUntil = 0;

  /* ------------------------------ Utilities ------------------------------ */

  function setText(el, txt) {
    if (!el) return;
    el.textContent = String(txt ?? "");
  }

  function show(el) {
    if (!el) return;
    el.style.display = "";
  }

  function hide(el) {
    if (!el) return;
    el.style.display = "none";
  }

  function now() {
    return Date.now();
  }

  function containsUrl(text) {
    return /(https?:\/\/|www\.)/i.test(String(text || ""));
  }

  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function setAuthUI({ loggedIn }) {
    if (loggedIn) {
      hide(elLoginModal);
      if (elLogoutBtn) elLogoutBtn.disabled = false;
      if (elGlobalInput) elGlobalInput.disabled = false;
      if (elGlobalSend) elGlobalSend.disabled = false;
      if (elUsername) elUsername.value = "";
      if (elPassword) elPassword.value = "";
    } else {
      show(elLoginModal);
      if (elLogoutBtn) elLogoutBtn.disabled = true;
      if (elGlobalInput) elGlobalInput.disabled = true;
      if (elGlobalSend) elGlobalSend.disabled = true;
    }
  }

  function setLoginMsg(msg) {
    if (!elLoginMsg) return;
    elLoginMsg.textContent = msg || "";
  }

  function setMeHeader(userObj) {
    if (!userObj) return;
    setText(elMeName, userObj.username || "");
    if (elMeBadge) {
      const badges = Array.isArray(userObj.badges) ? userObj.badges : [];
      setText(elMeBadge, badges.join(" • "));
      elMeBadge.style.display = badges.length ? "" : "none";
    }
  }

  /* ------------------------------ Networking ------------------------------ */

  async function api(path, { method = "GET", body, auth = false } = {}) {
    const headers = { "content-type": "application/json" };
    if (auth && token) headers.authorization = `Bearer ${token}`;

    const res = await fetch(API + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = data?.error || data?.message || `HTTP ${res.status}`;
      throw new Error(err);
    }
    return data;
  }

  /* ------------------------------ Socket ------------------------------ */

  function connectSocket() {
    if (socket) return;

    // io is expected to be loaded from /socket.io/socket.io.js in your HTML
    socket = window.io({
      auth: token ? { token } : {},
      transports: ["websocket", "polling"],
    });

    socket.on("connect", () => {
      // Request online count quickly
      socket.emit("online:get");
      // Get history
      socket.emit("global:history", { limit: 80 }, (resp) => {
        if (resp && resp.ok && Array.isArray(resp.items)) {
          renderGlobalHistory(resp.items);
        }
      });
    });

    socket.on("online:update", (p) => {
      if (!p) return;
      setText(elOnlineCount, p.online ?? "");
    });

    // New event
    socket.on("global:msg", (msg) => addGlobalMessage(msg));
    // Legacy event
    socket.on("globalMessage", (msg) => addGlobalMessage(msg));
    // Legacy history
    socket.on("history", (items) => {
      if (Array.isArray(items)) renderGlobalHistory(items.slice(-80));
    });

    socket.on("sendError", (p) => {
      const reason = p?.reason || "Send failed";
      toast(reason);
    });

    socket.on("shadow:notice", (p) => {
      const hint = p?.hint || "Message not delivered.";
      toast(hint);
    });

    // Optional: stats update
    socket.on("me:stats", (p) => {
      // You can show level up here if you want
      if (p?.leveled) toast(`Level up! Now level ${p.level}.`);
    });
  }

  /* ------------------------------ UI Rendering ------------------------------ */

  function ensureListEl() {
    if (!elGlobalList) return null;
    return elGlobalList;
  }

  function addGlobalMessage(msg) {
    const list = ensureListEl();
    if (!list || !msg) return;

    const user = escapeHtml(msg.user || "Unknown");
    const text = escapeHtml(msg.text || "");
    const time = fmtTime(msg.ts || now());

    const li = document.createElement("div");
    li.className = "msg";
    li.innerHTML = `
      <div class="meta">
        <span class="u">${user}</span>
        <span class="t">${escapeHtml(time)}</span>
      </div>
      <div class="body">${text}</div>
    `;

    list.appendChild(li);

    // Keep list trimmed
    const max = 250;
    while (list.children.length > max) list.removeChild(list.firstChild);

    // Auto-scroll
    list.scrollTop = list.scrollHeight;
  }

  function renderGlobalHistory(items) {
    const list = ensureListEl();
    if (!list) return;
    list.innerHTML = "";
    for (const it of items) addGlobalMessage(it);
  }

  function toast(text) {
    // If your site has a toast system, plug it in here.
    // Fallback: use login msg area or alert-like inline.
    if (elLoginMsg && (elLoginModal && elLoginModal.style.display !== "none")) {
      setLoginMsg(text);
      return;
    }
    console.log("[toast]", text);
  }

  /* ------------------------------ Cooldown UX ------------------------------ */

  function setCooldown(ms) {
    cooldownUntil = Math.max(cooldownUntil, now() + ms);
    updateCooldownUI();
  }

  function updateCooldownUI() {
    const left = Math.max(0, cooldownUntil - now());
    const disabled = left > 0;

    if (elGlobalSend) elGlobalSend.disabled = disabled;
    if (elGlobalInput) elGlobalInput.disabled = disabled;

    if (disabled) {
      const s = Math.ceil(left / 1000);
      if (elGlobalSend) elGlobalSend.textContent = `Wait ${s}s`;
    } else {
      if (elGlobalSend) elGlobalSend.textContent = "Send";
    }
  }

  setInterval(updateCooldownUI, 250);

  /* ------------------------------ Auth Flow ------------------------------ */

  async function login({ guest }) {
    setLoginMsg("");

    try {
      const body = guest
        ? { guest: true, client: "web" }
        : { username: elUsername?.value || "", password: elPassword?.value || "", guest: false, client: "web" };

      const resp = await api("/api/auth/login", { method: "POST", body });

      // Guest has no token
      if (resp.guest) {
        token = "";
        currentUser = resp.user?.username || "";
        isGuest = true;

        localStorage.removeItem(LS_TOKEN);
        localStorage.setItem(LS_USER, currentUser);
        localStorage.setItem(LS_GUEST, "1");
      } else {
        token = resp.token || "";
        currentUser = resp.user?.username || "";
        isGuest = false;

        localStorage.setItem(LS_TOKEN, token);
        localStorage.setItem(LS_USER, currentUser);
        localStorage.setItem(LS_GUEST, "0");
      }

      setMeHeader(resp.user);
      setAuthUI({ loggedIn: true });

      // Reconnect socket with new auth
      if (socket) {
        socket.disconnect();
        socket = null;
      }
      connectSocket();

      if (resp.isNew) toast("Account created.");
      else toast("Logged in.");

      return true;
    } catch (e) {
      setLoginMsg(e.message || "Login failed.");
      return false;
    }
  }

  async function tryResume() {
    if (!token) return false;

    try {
      const me = await api("/api/me", { auth: true });
      if (me && me.ok) {
        currentUser = me.user?.username || currentUser;
        isGuest = false;
        localStorage.setItem(LS_USER, currentUser);
        localStorage.setItem(LS_GUEST, "0");

        setMeHeader(me.user);
        setAuthUI({ loggedIn: true });
        connectSocket();
        return true;
      }
    } catch {
      // token invalid
      localStorage.removeItem(LS_TOKEN);
      token = "";
    }
    return false;
  }

  function logout() {
    token = "";
    currentUser = "";
    isGuest = false;
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_USER);
    localStorage.removeItem(LS_GUEST);

    if (socket) {
      socket.disconnect();
      socket = null;
    }

    setAuthUI({ loggedIn: false });
    setText(elMeName, "");
    if (elMeBadge) hide(elMeBadge);
  }

  /* ------------------------------ Sending Global ------------------------------ */

  function canSendClientSide(text) {
    const t = String(text || "").trim();
    if (!t) return { ok: false, error: "Empty message." };
    if (t.length > 1200) return { ok: false, error: "Message too long." };

    if (containsUrl(t)) {
      const since = now() - lastLinkAt;
      if (lastLinkAt && since < LINK_COOLDOWN_MS) {
        const left = Math.ceil((LINK_COOLDOWN_MS - since) / 1000);
        return { ok: false, error: `Link cooldown (client hint): wait ${left}s.` };
      }
    }
    return { ok: true };
  }

  function sendGlobal() {
    const t = String(elGlobalInput?.value || "").trim();
    if (!t) return;

    if (!currentUser) {
      toast("Please log in.");
      return;
    }

    const check = canSendClientSide(t);
    if (!check.ok) {
      toast(check.error);
      return;
    }

    // Client records link timestamp (server enforces anyway)
    if (containsUrl(t)) lastLinkAt = now();

    // Optimistic clear
    if (elGlobalInput) elGlobalInput.value = "";

    // Guests: server.js expects auth for socket send too; in our server, guests are allowed only if they logged in via socket "login".
    // Since this client uses REST guest login, guests cannot send; enforce that here.
    if (isGuest) {
      toast("Guests can read only. Create an account to chat.");
      return;
    }

    if (!socket) connectSocket();

    socket.emit("global:send", { text: t }, (resp) => {
      if (!resp || !resp.ok) {
        toast(resp?.error || "Send failed.");
        return;
      }
      if (resp.cooldownMs) setCooldown(resp.cooldownMs);
    });
  }

  /* ------------------------------ Wire Up ------------------------------ */

  function bind() {
    if (elLoginBtn) {
      elLoginBtn.addEventListener("click", () => void login({ guest: false }));
    }
    if (elGuestBtn) {
      elGuestBtn.addEventListener("click", () => void login({ guest: true }));
    }
    if (elLogoutBtn) {
      elLogoutBtn.addEventListener("click", () => logout());
    }

    if (elGlobalSend) elGlobalSend.addEventListener("click", () => sendGlobal());
    if (elGlobalInput) {
      elGlobalInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendGlobal();
        }
      });
    }
  }

  async function boot() {
    bind();
    setAuthUI({ loggedIn: false });

    // Send small telemetry ping (optional)
    fetch("/api/telemetry/hello", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(
      () => {}
    );

    const ok = await tryResume();
    if (!ok) {
      // Not logged in; show modal
      setAuthUI({ loggedIn: false });
    }
  }

  boot();
})();

