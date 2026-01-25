<!-- public/index.html — tonkotsu.online -->
<!-- Black-only theme. No inbox/settings on login screen. App shell mounts after auth. -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      name="viewport"
      content="width=device-width,initial-scale=1,maximum-scale=1,viewport-fit=cover"
    />
    <meta name="color-scheme" content="dark" />
    <meta name="theme-color" content="#000000" />
    <title>tonkotsu.online</title>

    <style>
      /* ============================================================
         GLOBAL RESET + BLACK THEME (NO LIGHT THEME FALLBACKS)
         ============================================================ */

      :root {
        --bg0: #000000;
        --bg1: #07070b;
        --bg2: #0b0b10;
        --bg3: #101018;
        --fg0: #ffffff;
        --fg1: rgba(255, 255, 255, 0.92);
        --fg2: rgba(255, 255, 255, 0.72);
        --fg3: rgba(255, 255, 255, 0.55);

        --line0: rgba(255, 255, 255, 0.08);
        --line1: rgba(255, 255, 255, 0.12);
        --line2: rgba(255, 255, 255, 0.16);

        --good: #29ffb2;
        --warn: #ffcc66;
        --bad: #ff4b6e;
        --accent: #7a5cff; /* subtle purple */
        --accent2: #22d3ee; /* cyan */
        --glow: rgba(122, 92, 255, 0.35);

        --shadow: 0 12px 60px rgba(0, 0, 0, 0.75);
        --shadow2: 0 22px 90px rgba(0, 0, 0, 0.85);

        --r-lg: 18px;
        --r-md: 14px;
        --r-sm: 12px;

        --pad-lg: 20px;
        --pad-md: 14px;
        --pad-sm: 10px;

        --text-xl: 18px;
        --text-lg: 16px;
        --text-md: 14px;
        --text-sm: 12.5px;

        --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
          "Liberation Mono", "Courier New", monospace;
        --sans: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica,
          Arial, "Apple Color Emoji", "Segoe UI Emoji";
      }

      * {
        box-sizing: border-box;
      }
      html,
      body {
        height: 100%;
        background: var(--bg0);
        color: var(--fg0);
        margin: 0;
        font-family: var(--sans);
        -webkit-font-smoothing: antialiased;
        text-rendering: geometricPrecision;
        overflow: hidden; /* app handles scroll */
      }

      ::selection {
        background: rgba(122, 92, 255, 0.35);
      }

      a {
        color: inherit;
        text-decoration: none;
      }

      button,
      input {
        font: inherit;
        color: inherit;
        outline: none;
      }

      /* ============================================================
         BACKGROUND AESTHETIC
         ============================================================ */
      .bg {
        position: fixed;
        inset: 0;
        background: radial-gradient(
            1200px 800px at 30% 15%,
            rgba(122, 92, 255, 0.12),
            transparent 55%
          ),
          radial-gradient(
            1200px 800px at 75% 70%,
            rgba(34, 211, 238, 0.08),
            transparent 55%
          ),
          radial-gradient(
            900px 700px at 50% 55%,
            rgba(255, 255, 255, 0.045),
            transparent 60%
          ),
          linear-gradient(180deg, var(--bg0), var(--bg2));
        filter: saturate(115%);
        z-index: 0;
      }

      .grain {
        position: fixed;
        inset: 0;
        pointer-events: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='240' height='240' filter='url(%23n)' opacity='.22'/%3E%3C/svg%3E");
        mix-blend-mode: overlay;
        opacity: 0.25;
        z-index: 1;
      }

      /* ============================================================
         CUSTOM CURSOR (DEFAULT ENABLED; BIGGER + DYNAMIC)
         script.js will attach & animate it; CSS provides baseline.
         ============================================================ */
      body.cursor-on {
        cursor: none;
      }

      .cursor {
        position: fixed;
        left: 0;
        top: 0;
        width: 18px;
        height: 18px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid rgba(255, 255, 255, 0.18);
        box-shadow: 0 0 20px rgba(122, 92, 255, 0.18);
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 99999;
        opacity: 0;
        transition: opacity 160ms ease;
      }
      body.cursor-on .cursor {
        opacity: 1;
      }

      .cursorDot {
        position: fixed;
        left: 0;
        top: 0;
        width: 6px;
        height: 6px;
        border-radius: 999px;
        background: rgba(122, 92, 255, 0.85);
        box-shadow: 0 0 18px rgba(122, 92, 255, 0.55);
        transform: translate(-50%, -50%);
        pointer-events: none;
        z-index: 100000;
        opacity: 0;
        transition: opacity 160ms ease;
      }
      body.cursor-on .cursorDot {
        opacity: 1;
      }

      /* ============================================================
         LAYOUT SHELL
         ============================================================ */
      #app {
        position: relative;
        z-index: 2;
        height: 100%;
        display: grid;
        grid-template-columns: 1fr;
        grid-template-rows: 1fr;
      }

      /* ============================================================
         LOGIN OVERLAY (NO INBOX/SETTINGS HERE)
         ============================================================ */
      .auth {
        position: absolute;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 28px;
      }

      .authCard {
        width: min(520px, 96vw);
        border-radius: var(--r-lg);
        background: linear-gradient(180deg, rgba(16, 16, 24, 0.92), rgba(9, 9, 14, 0.9));
        border: 1px solid var(--line1);
        box-shadow: var(--shadow2);
        overflow: hidden;
      }

      .authHeader {
        padding: 22px 22px 14px 22px;
        border-bottom: 1px solid var(--line0);
        background: radial-gradient(
            900px 400px at 15% 0%,
            rgba(122, 92, 255, 0.18),
            transparent 60%
          ),
          radial-gradient(
            900px 400px at 85% 40%,
            rgba(34, 211, 238, 0.12),
            transparent 60%
          );
      }

      .brandRow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
      }

      .brand {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .brandTitle {
        font-size: 22px;
        letter-spacing: 0.2px;
        font-weight: 750;
        line-height: 1.05;
      }

      .brandSub {
        color: var(--fg2);
        font-size: var(--text-md);
        line-height: 1.35;
        max-width: 40ch;
      }

      .betaPill {
        font-family: var(--mono);
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);
        color: rgba(255, 255, 255, 0.82);
        white-space: nowrap;
      }

      .authBody {
        padding: 18px 22px 22px 22px;
        display: grid;
        gap: 14px;
      }

      .field {
        display: grid;
        gap: 8px;
      }

      .labelRow {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
      }

      label {
        font-size: var(--text-sm);
        color: var(--fg2);
      }

      .hint {
        font-size: var(--text-sm);
        color: var(--fg3);
      }

      .input {
        width: 100%;
        padding: 12px 12px;
        border-radius: var(--r-md);
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(0, 0, 0, 0.55);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
        font-size: var(--text-lg); /* slightly larger */
        transition: border 140ms ease, transform 140ms ease;
      }

      .input:focus {
        border-color: rgba(122, 92, 255, 0.45);
        transform: translateY(-1px);
      }

      .btnRow {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin-top: 6px;
      }

      .btn {
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.06);
        border-radius: var(--r-md);
        padding: 12px 12px;
        font-weight: 700;
        font-size: var(--text-lg);
        cursor: pointer;
        transition: transform 120ms ease, background 120ms ease, border 120ms ease;
        user-select: none;
      }

      .btn:hover {
        transform: translateY(-1px);
        background: rgba(255, 255, 255, 0.09);
        border-color: rgba(255, 255, 255, 0.16);
      }

      .btn:active {
        transform: translateY(0px);
      }

      .btnPrimary {
        border-color: rgba(122, 92, 255, 0.35);
        background: linear-gradient(
          180deg,
          rgba(122, 92, 255, 0.22),
          rgba(122, 92, 255, 0.1)
        );
        box-shadow: 0 0 0 1px rgba(122, 92, 255, 0.08), 0 14px 50px rgba(122, 92, 255, 0.12);
      }

      .btnPrimary:hover {
        border-color: rgba(122, 92, 255, 0.5);
      }

      .divider {
        height: 1px;
        background: rgba(255, 255, 255, 0.08);
        margin: 8px 0 4px;
      }

      .footRow {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        color: var(--fg3);
        font-size: var(--text-sm);
      }

      .smallLink {
        color: rgba(255, 255, 255, 0.78);
        text-decoration: underline;
        text-underline-offset: 3px;
        cursor: pointer;
      }

      .err {
        min-height: 18px;
        font-size: var(--text-sm);
        color: var(--bad);
      }

      .ok {
        min-height: 18px;
        font-size: var(--text-sm);
        color: var(--good);
      }

      /* ============================================================
         LOADING SCREEN (quick after logging in)
         ============================================================ */
      .loading {
        position: absolute;
        inset: 0;
        display: none;
        place-items: center;
        background: rgba(0, 0, 0, 0.65);
        backdrop-filter: blur(10px);
        z-index: 10;
      }
      .loading.show {
        display: grid;
      }

      .loadingCard {
        width: min(520px, 96vw);
        padding: 22px;
        border-radius: var(--r-lg);
        background: linear-gradient(180deg, rgba(16, 16, 24, 0.9), rgba(9, 9, 14, 0.88));
        border: 1px solid rgba(255, 255, 255, 0.12);
        box-shadow: var(--shadow2);
      }

      .loadTitle {
        font-size: 18px;
        font-weight: 760;
        letter-spacing: 0.2px;
      }

      .loadSub {
        margin-top: 8px;
        color: var(--fg2);
        font-size: var(--text-md);
        line-height: 1.4;
      }

      .bar {
        margin-top: 14px;
        height: 10px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(0, 0, 0, 0.55);
        overflow: hidden;
      }

      .bar > div {
        height: 100%;
        width: 0%;
        border-radius: 999px;
        background: linear-gradient(90deg, rgba(122, 92, 255, 0.55), rgba(34, 211, 238, 0.45));
        box-shadow: 0 0 30px rgba(122, 92, 255, 0.22);
        transition: width 140ms ease;
      }

      /* ============================================================
         APP UI (hidden until authenticated)
         ============================================================ */
      .shell {
        height: 100%;
        display: none; /* script shows after auth */
        grid-template-columns: 340px 1fr; /* left chat list + main */
        grid-template-rows: 1fr;
        gap: 0;
      }

      .shell.show {
        display: grid;
      }

      .left {
        height: 100%;
        border-right: 1px solid var(--line0);
        background: linear-gradient(180deg, rgba(8, 8, 12, 0.9), rgba(0, 0, 0, 0.92));
        display: flex;
        flex-direction: column;
        min-width: 300px;
      }

      .leftTop {
        padding: 16px 16px 12px;
        border-bottom: 1px solid var(--line0);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .userMini {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .userName {
        font-weight: 760;
        font-size: 16px;
        line-height: 1.1;
      }

      .userMeta {
        font-family: var(--mono);
        font-size: 12px;
        color: var(--fg3);
      }

      .pill {
        font-family: var(--mono);
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.04);
        color: rgba(255, 255, 255, 0.82);
        white-space: nowrap;
      }

      .tabs {
        padding: 10px 10px 12px;
        display: grid;
        gap: 8px;
      }

      .tabBtn {
        width: 100%;
        text-align: left;
        padding: 12px 12px;
        border-radius: var(--r-md);
        border: 1px solid rgba(255, 255, 255, 0.1);
        background: rgba(255, 255, 255, 0.04);
        cursor: pointer;
        transition: transform 120ms ease, background 120ms ease, border 120ms ease;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        font-weight: 720;
        font-size: 15px;
      }

      .tabBtn:hover {
        transform: translateY(-1px);
        background: rgba(255, 255, 255, 0.07);
        border-color: rgba(255, 255, 255, 0.15);
      }

      .tabBtn.active {
        border-color: rgba(122, 92, 255, 0.35);
        background: linear-gradient(
          180deg,
          rgba(122, 92, 255, 0.18),
          rgba(122, 92, 255, 0.08)
        );
        box-shadow: 0 0 0 1px rgba(122, 92, 255, 0.06);
      }

      .badgeCount {
        font-family: var(--mono);
        font-size: 12px;
        padding: 4px 8px;
        border-radius: 999px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(0, 0, 0, 0.5);
        color: rgba(255, 255, 255, 0.8);
        min-width: 34px;
        text-align: center;
      }

      .leftFooter {
        margin-top: auto;
        padding: 12px 12px 14px;
        border-top: 1px solid var(--line0);
        display: flex;
        gap: 10px;
      }

      .smallBtn {
        flex: 1;
        border-radius: var(--r-md);
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.05);
        padding: 10px 10px;
        cursor: pointer;
        font-weight: 720;
        transition: transform 120ms ease, background 120ms ease, border 120ms ease;
      }

      .smallBtn:hover {
        transform: translateY(-1px);
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.16);
      }

      .main {
        height: 100%;
        display: grid;
        grid-template-rows: auto 1fr auto;
        background: linear-gradient(180deg, rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.9));
      }

      .mainTop {
        padding: 14px 16px;
        border-bottom: 1px solid var(--line0);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .roomTitle {
        font-weight: 800;
        font-size: 17px;
        letter-spacing: 0.2px;
      }

      .roomMeta {
        font-family: var(--mono);
        font-size: 12px;
        color: var(--fg3);
      }

      .mainMid {
        overflow: auto;
        padding: 16px;
      }

      .mainMid::-webkit-scrollbar {
        width: 10px;
      }
      .mainMid::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.10);
        border-radius: 999px;
      }
      .mainMid::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.4);
      }

      .composer {
        padding: 12px 12px 14px;
        border-top: 1px solid var(--line0);
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 10px;
      }

      .composerInput {
        width: 100%;
        padding: 12px 12px;
        border-radius: var(--r-md);
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(0, 0, 0, 0.55);
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
        font-size: 15px;
      }

      .sendBtn {
        border-radius: var(--r-md);
        border: 1px solid rgba(122, 92, 255, 0.35);
        background: linear-gradient(
          180deg,
          rgba(122, 92, 255, 0.22),
          rgba(122, 92, 255, 0.1)
        );
        padding: 12px 16px;
        cursor: pointer;
        font-weight: 760;
        transition: transform 120ms ease, background 120ms ease, border 120ms ease;
      }

      .sendBtn:hover {
        transform: translateY(-1px);
        border-color: rgba(122, 92, 255, 0.5);
      }

      /* responsive */
      @media (max-width: 900px) {
        .shell.show {
          grid-template-columns: 1fr;
        }
        .left {
          display: none; /* mobile can be added later; keep simple */
        }
      }

      /* ============================================================
         MESSAGE STYLES (used by script.js)
         ============================================================ */
      .msg {
        max-width: 860px;
        padding: 12px 12px;
        border-radius: var(--r-md);
        border: 1px solid rgba(255, 255, 255, 0.10);
        background: rgba(255, 255, 255, 0.04);
        margin-bottom: 10px;
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
      }

      .msgTop {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 6px;
      }

      .msgUser {
        font-weight: 780;
        letter-spacing: 0.2px;
        font-size: 14.5px;
      }

      .msgTime {
        font-family: var(--mono);
        font-size: 11.5px;
        color: var(--fg3);
      }

      .msgText {
        font-size: 14.5px;
        line-height: 1.45;
        color: var(--fg1);
        word-break: break-word;
        white-space: pre-wrap;
      }

      .sys {
        opacity: 0.85;
        border-style: dashed;
        background: rgba(255, 255, 255, 0.03);
      }

      .toastWrap {
        position: fixed;
        left: 50%;
        bottom: 18px;
        transform: translateX(-50%);
        z-index: 9999;
        width: min(560px, 92vw);
        display: grid;
        gap: 10px;
        pointer-events: none;
      }

      .toast {
        pointer-events: none;
        padding: 12px 12px;
        border-radius: var(--r-md);
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(8px);
        color: rgba(255, 255, 255, 0.92);
        box-shadow: var(--shadow);
        font-size: 13px;
        line-height: 1.35;
      }
    </style>
  </head>

  <body class="cursor-on">
    <div class="bg"></div>
    <div class="grain"></div>

    <!-- custom cursor elements (script animates) -->
    <div class="cursor" id="cursor"></div>
    <div class="cursorDot" id="cursorDot"></div>

    <div id="app">
      <!-- AUTH (LOGIN) -->
      <section class="auth" id="authView" aria-label="Authentication">
        <div class="authCard">
          <div class="authHeader">
            <div class="brandRow">
              <div class="brand">
                <div class="brandTitle">tonkotsu.online</div>
                <div class="brandSub">
                  Secure, fast chat. First login creates the account. After that, the password must match.
                </div>
              </div>
              <div class="betaPill">BETA</div>
            </div>
          </div>

          <div class="authBody">
            <div class="field">
              <div class="labelRow">
                <label for="username">Username</label>
                <div class="hint">4–20 letters/numbers</div>
              </div>
              <input
                id="username"
                class="input"
                autocomplete="username"
                spellcheck="false"
                inputmode="text"
                placeholder="e.g. lazeblaze"
                maxlength="20"
              />
            </div>

            <div class="field">
              <div class="labelRow">
                <label for="password">Password</label>
                <div class="hint">4–72 chars</div>
              </div>
              <input
                id="password"
                class="input"
                type="password"
                autocomplete="current-password"
                spellcheck="false"
                placeholder="Enter password"
                maxlength="72"
              />
            </div>

            <div class="btnRow">
              <button class="btn btnPrimary" id="btnLogin" type="button">Log in / Create</button>
              <button class="btn" id="btnGuest" type="button">Continue as Guest</button>
            </div>

            <div class="divider"></div>

            <div id="authMsg" class="err"></div>

            <div class="footRow">
              <div>Global chat is public and logged.</div>
              <div class="smallLink" id="btnStatus">Status</div>
            </div>
          </div>
        </div>
      </section>

      <!-- QUICK LOADING SCREEN AFTER LOGIN -->
      <section class="loading" id="loadingView" aria-label="Loading">
        <div class="loadingCard">
          <div class="loadTitle" id="loadTitle">Signing you in…</div>
          <div class="loadSub" id="loadSub">
            Establishing a secure session and connecting to chat servers.
          </div>
          <div class="bar"><div id="loadBar"></div></div>
        </div>
      </section>

      <!-- MAIN APP SHELL -->
      <section class="shell" id="shell" aria-label="App Shell">
        <aside class="left" aria-label="Sidebar">
          <div class="leftTop">
            <div class="userMini">
              <div class="userName" id="meName">—</div>
              <div class="userMeta" id="meMeta">LEVEL 1 • ONLINE 0</div>
            </div>
            <div class="pill" id="betaPill2">BETA</div>
          </div>

          <div class="tabs">
            <button class="tabBtn active" id="tabGlobal" type="button">
              <span>Global</span>
              <span class="badgeCount" id="globalCount">—</span>
            </button>

            <button class="tabBtn" id="tabInbox" type="button">
              <span>Inbox</span>
              <span class="badgeCount" id="inboxCount">0</span>
            </button>

            <button class="tabBtn" id="tabSettings" type="button">
              <span>Settings</span>
              <span class="badgeCount" id="settingsDot">•</span>
            </button>
          </div>

          <div class="leftFooter">
            <button class="smallBtn" id="btnLogout" type="button">Log out</button>
            <button class="smallBtn" id="btnPing" type="button">Reconnect</button>
          </div>
        </aside>

        <main class="main" aria-label="Main">
          <header class="mainTop">
            <div>
              <div class="roomTitle" id="roomTitle">Global</div>
              <div class="roomMeta" id="roomMeta">Public room • Be respectful</div>
            </div>
            <div class="pill" id="onlinePill">ONLINE 0</div>
          </header>

          <section class="mainMid" id="feed" aria-label="Messages">
            <!-- script.js renders messages here -->
          </section>

          <footer class="composer" aria-label="Composer">
            <input
              id="composer"
              class="composerInput"
              placeholder="Type a message…"
              autocomplete="off"
              spellcheck="true"
            />
            <button id="btnSend" class="sendBtn" type="button">Send</button>
          </footer>
        </main>
      </section>

      <!-- TOASTS -->
      <div class="toastWrap" id="toastWrap" aria-live="polite" aria-atomic="true"></div>
    </div>

    <!-- Socket.IO from the server -->
    <script src="/socket.io/socket.io.js"></script>
    <script src="/script.js"></script>
  </body>
</html>

