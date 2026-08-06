// public/js/connection-overlay.js
// Full-screen overlay for connection events. On "server restarting" it shows a
// countdown, then reloads the page (which reconnects to the fresh server and
// rejoins the one persistent room). On an unexpected disconnect it shows a
// "reconnecting" notice instead of letting the page silently freeze. Attached
// by the sign-in and room clients.
(function () {
  "use strict";
  var restarting = false;
  var reconnectTimer = null;
  var buttonsTimer = null;
  // When true (the room page), a restart does NOT reload the page - it shows
  // an "updating" notice and lets Socket.IO reconnect, so the client can
  // rejoin the same room in place. The sign-in page leaves this false and
  // keeps the old countdown+reload (harmless there, since it has no room to
  // stay in).
  var rejoinInPlace = false;

  function styles() {
    if (document.getElementById("tkConnStyles")) return;
    var st = document.createElement("style");
    st.id = "tkConnStyles";
    st.textContent =
      "#tkConnOverlay{position:fixed;inset:0;z-index:1000003;background:rgba(8,8,8,.92);" +
      "display:none;align-items:center;justify-content:center;padding:20px;font-family:Arial,sans-serif;}" +
      "#tkConnOverlay .tk-conn-box{max-width:440px;width:100%;background:#181818;border:1px solid #616161;" +
      "border-radius:10px;padding:34px 28px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.6);}" +
      "#tkConnOverlay .tk-conn-title{color:#ff9800;font-size:23px;font-weight:bold;margin:0 0 8px;}" +
      "#tkConnOverlay .tk-conn-msg{color:#ddd;font-size:15px;line-height:1.5;margin:0;}" +
      "#tkConnOverlay .tk-conn-msg b{color:#fff;font-size:20px;}" +
      "#tkConnOverlay .tk-conn-bar{height:6px;background:#333;border-radius:4px;overflow:hidden;margin-top:16px;}" +
      "#tkConnOverlay .tk-conn-bar span{display:block;height:100%;width:0;background:#ff9800;transition:width 1s linear;}" +
      "#tkConnOverlay .tk-conn-spinner{width:42px;height:42px;border:4px solid #333;border-top-color:#ff9800;" +
      "border-radius:50%;margin:0 auto 16px;animation:tkConnSpin 1s linear infinite;}" +
      "#tkConnOverlay .tk-conn-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px;}" +
      "#tkConnOverlay button{background:#ff9800;color:#000;border:none;border-radius:5px;" +
      "padding:10px 18px;font-size:14px;font-weight:bold;cursor:pointer;font-family:inherit;}" +
      "#tkConnOverlay button.tk-conn-ghost{background:transparent;color:#ddd;border:1px solid #616161;}" +
      "@keyframes tkConnSpin{to{transform:rotate(360deg);}}";
    document.head.appendChild(st);
  }

  function overlay() {
    var o = document.getElementById("tkConnOverlay");
    if (!o) {
      o = document.createElement("div");
      o.id = "tkConnOverlay";
      document.body.appendChild(o);
    }
    return o;
  }

  function showRestart(seconds) {
    restarting = true;
    styles();
    var total = seconds || 5;
    var o = overlay();
    o.innerHTML =
      '<div class="tk-conn-box"><div class="tk-conn-title">Talkomatic is updating</div>' +
      '<div class="tk-conn-msg">Reconnecting you in <b id="tkConnN">' +
      total +
      "</b> seconds…</div>" +
      '<div class="tk-conn-bar"><span id="tkConnBar"></span></div></div>';
    o.style.display = "flex";
    var n = total;
    (function tick() {
      var nEl = document.getElementById("tkConnN");
      var bar = document.getElementById("tkConnBar");
      if (nEl) nEl.textContent = String(Math.max(0, n));
      if (bar) bar.style.width = 100 * (1 - n / total) + "%";
      if (n <= 0) {
        window.location.href = "/";
        return;
      }
      n--;
      setTimeout(tick, 1000);
    })();
  }

  function actionButton(label, ghost, onClick) {
    var b = document.createElement("button");
    b.textContent = label;
    if (ghost) b.className = "tk-conn-ghost";
    b.addEventListener("click", onClick);
    return b;
  }

  // A reload was supposed to pick up the new build and did not. Rather than
  // bouncing the page forever, say what is wrong and offer the one thing that
  // always works.
  function showOutdated() {
    styles();
    var o = overlay();
    o.innerHTML =
      '<div class="tk-conn-box">' +
      '<div class="tk-conn-title">Talkomatic has been updated</div>' +
      '<div class="tk-conn-msg">This tab is still running the old version and ' +
      "a refresh did not replace it. Hold Shift and press refresh, or clear " +
      "this site's cache.</div>" +
      '<div class="tk-conn-actions"></div></div>';
    var actions = o.querySelector(".tk-conn-actions");
    actions.appendChild(
      actionButton("Try again", false, function () {
        try {
          sessionStorage.removeItem("tk-build-reload");
        } catch (e) {
          /* nothing to clear */
        }
        window.location.reload();
      }),
    );
    o.style.display = "flex";
  }

  function showReconnecting() {
    if (restarting) return;
    styles();
    var o = overlay();
    o.innerHTML =
      '<div class="tk-conn-box"><div class="tk-conn-spinner"></div>' +
      '<div class="tk-conn-title">Reconnecting…</div>' +
      '<div class="tk-conn-msg">Lost connection to Talkomatic. Trying to reconnect…</div>' +
      '<div class="tk-conn-actions"></div></div>';
    var actions = o.querySelector(".tk-conn-actions");
    actions.appendChild(
      actionButton("Refresh", false, function () {
        window.location.reload();
      }),
    );
    actions.appendChild(
      actionButton("Start over", true, function () {
        window.location.href = "/";
      }),
    );
    o.style.display = "flex";
  }

  // Room page: a restart shows this notice and we wait for Socket.IO to
  // reconnect (the room client then rejoins in place). No countdown, no
  // redirect - the connect handler hides it once we are back.
  function showUpdating() {
    restarting = true;
    styles();
    var o = overlay();
    o.innerHTML =
      '<div class="tk-conn-box"><div class="tk-conn-spinner"></div>' +
      '<div class="tk-conn-title">Talkomatic is updating</div>' +
      '<div class="tk-conn-msg">Reconnecting you to your room. Hold tight, ' +
      "this only takes a moment.</div>" +
      '<div class="tk-conn-actions" style="display:none"></div></div>';
    // If the auto-rejoin stalls, give the user a reliable way out instead of an
    // endless spinner. Rejoin reloads the page, which always re-enters the room.
    var actions = o.querySelector(".tk-conn-actions");
    actions.appendChild(
      actionButton("Rejoin room", false, function () {
        window.location.reload();
      }),
    );
    actions.appendChild(
      actionButton("Start over", true, function () {
        window.location.href = "/";
      }),
    );
    o.style.display = "flex";
    clearTimeout(buttonsTimer);
    buttonsTimer = setTimeout(function () {
      actions.style.display = "";
    }, 5000);
  }

  function hide() {
    if (restarting) return;
    clearTimeout(buttonsTimer);
    var o = document.getElementById("tkConnOverlay");
    if (o) o.style.display = "none";
  }

  // Called by the room client once it is genuinely back in the room. Forces the
  // overlay closed even while the restarting latch is set.
  function recovered() {
    clearTimeout(reconnectTimer);
    clearTimeout(buttonsTimer);
    restarting = false;
    var o = document.getElementById("tkConnOverlay");
    if (o) o.style.display = "none";
  }

  window.TalkomaticConnection = {
    attach: function (socket, opts) {
      if (!socket) return;
      rejoinInPlace = !!(opts && opts.rejoinInPlace);
      // A room page rejoins in place across a restart, so it keeps running the
      // scripts and stylesheets it started with however many times the server
      // is redeployed. The server names its build on every connect; if ours is
      // older we reload once, now that the server is provably back up. Asset
      // urls are content-stamped, so an ordinary reload is enough to pull the
      // new files - no hard refresh needed.
      socket.on("server build", function (d) {
        var theirs = d && d.id;
        if (!theirs) return;
        var tag = document.querySelector('meta[name="tk-build"]');
        var ours = tag && tag.getAttribute("content");
        if (!ours || ours === theirs) return;
        // If a reload did not fix it (a proxy serving stale html, say), do not
        // sit in a loop: say so once and let the person decide.
        var tried = null;
        try {
          tried = sessionStorage.getItem("tk-build-reload");
        } catch (e) {
          tried = null;
        }
        if (tried === theirs) return showOutdated();
        try {
          sessionStorage.setItem("tk-build-reload", theirs);
        } catch (e) {
          /* private mode: we simply lose the loop guard */
        }
        window.location.reload();
      });
      socket.on("server restarting", function (d) {
        if (rejoinInPlace) showUpdating();
        else showRestart((d && d.seconds) || 5);
      });
      socket.on("disconnect", function (reason) {
        // Ignore intentional disconnects (tab handoff, navigation).
        if (restarting || reason === "io client disconnect") return;
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(showReconnecting, 1200); // grace for blips
      });
      socket.on("connect", function () {
        clearTimeout(reconnectTimer);
        // On the room page the socket being back is not enough: we stay on the
        // notice until the room rejoin lands (recovered() from "room joined"),
        // so a reconnect that fails to restore the room doesn't leave a blank
        // screen. The lobby has nothing to rejoin, so connecting is enough.
        if (rejoinInPlace) return;
        restarting = false;
        hide();
      });
    },
    recovered: recovered,
  };
})();
