(() => {
  "use strict";

  if (window.__TONKOTSU_LOADED__) return;
  window.__TONKOTSU_LOADED__ = true;

  const $ = (s) => document.querySelector(s);
  const api = async (path, body) => {
    const res = await fetch(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: localStorage.tk_token
          ? `Bearer ${localStorage.tk_token}`
          : "",
      },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "API error");
    return data;
  };

  const loginWrap = $("#loginWrap");
  const app = $("#app");
  const btnLogin = $("#btnLogin");
  const btnGuest = $("#btnGuest");
  const userInput = $("#loginUser");
  const passInput = $("#loginPass");
  const msg = $("#loginMsg");

  async function doLogin() {
    msg.textContent = "Signing in…";
    try {
      const r = await api("/api/auth/login", {
        username: userInput.value,
        password: passInput.value,
      });
      localStorage.tk_token = r.token;
      localStorage.tk_user = JSON.stringify(r.user);
      start();
    } catch (e) {
      msg.textContent = e.message;
    }
  }

  async function doGuest() {
    msg.textContent = "Starting guest…";
    try {
      const r = await api("/api/auth/guest");
      localStorage.tk_token = r.token;
      localStorage.tk_user = JSON.stringify(r.user);
      start();
    } catch (e) {
      msg.textContent = e.message;
    }
  }

  btnLogin.onclick = doLogin;
  btnGuest.onclick = doGuest;

  async function start() {
    loginWrap.style.display = "none";
    app.style.display = "block";

    const r = await fetch("/api/state/bootstrap", {
      headers: {
        Authorization: `Bearer ${localStorage.tk_token}`,
      },
    });
    const data = await r.json();
    console.log("BOOTSTRAP:", data);

    const socket = io({
      auth: { token: localStorage.tk_token },
    });

    socket.on("connect", () => console.log("socket connected"));
    socket.on("users:online", (p) => console.log("online", p));
  }

  if (localStorage.tk_token) start();
})();
