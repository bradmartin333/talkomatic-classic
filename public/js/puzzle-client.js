// public/js/puzzle-client.js
// Opens the collaborative puzzle (public/pages/puzzle.html) in a room modal and
// bridges its messages over the room's existing socket. The puzzle page runs in
// a sandboxed same-origin iframe so its canvas/UI can't collide with the room
// page, but all traffic still flows on the room socket - no second connection.
(function () {
  let overlay = null;
  let frame = null;
  let isOpen = false;
  let savedChatText = "";

  function toFrame(msg) {
    if (frame && frame.contentWindow)
      try {
        frame.contentWindow.postMessage(msg, location.origin);
      } catch (_) {}
  }

  // iframe -> room socket
  function bridgeFromFrame(e) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin)
      return;
    const d = e.data || {};
    if (d.t === "puzzle-out" && d.buf) socket.emit("puzzle msg", d.buf);
    else if (d.t === "puzzle-open") socket.emit("puzzle open");
    else if (d.t === "puzzle-end") socket.emit("puzzle end");
    else if (d.t === "puzzle-leave") closePuzzle();
  }

  // room socket -> iframe
  socket.on("puzzle msg", (buf) => {
    const ab =
      buf instanceof ArrayBuffer ? buf : buf && buf.buffer ? buf.buffer : buf;
    toFrame({ t: "puzzle-in", buf: ab });
  });
  socket.on("puzzle none", () => toFrame({ t: "puzzle-none" }));
  socket.on("puzzle active", (d) => {
    if (isOpen) {
      socket.emit("puzzle open"); // a (new) board exists; (re)join it
    } else if (typeof notify === "function") {
      notify(
        (d && d.by ? d.by : "Someone") +
          " started a puzzle. Open Apps and pick Puzzle to join.",
        "info",
        { timeout: 6000 },
      );
    }
  });

  function openPuzzle() {
    if (isOpen) return;
    if (!currentRoomId) return;
    isOpen = true;

    overlay = document.createElement("div");
    overlay.id = "puzzleOverlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:100000;background:#202020;display:flex;flex-direction:column;";

    const bar = document.createElement("div");
    bar.style.cssText =
      "height:40px;flex:none;display:flex;align-items:center;justify-content:space-between;" +
      "padding:0 14px;background:#1a1a1a;color:#fff;font-family:Arial,sans-serif;font-size:14px;";
    const title = document.createElement("span");
    title.style.cssText = "color:#ff9800;font-weight:bold;";
    title.textContent = "🧩 Puzzle";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.textContent = "✕";
    closeBtn.title = "Close puzzle";
    closeBtn.style.cssText =
      "background:none;border:none;color:#ff9800;font-size:20px;cursor:pointer;line-height:1;";
    closeBtn.addEventListener("click", closePuzzle);
    bar.appendChild(title);
    bar.appendChild(closeBtn);

    frame = document.createElement("iframe");
    const name = encodeURIComponent(
      (typeof currentUsername !== "undefined" && currentUsername) || "",
    );
    frame.src =
      "puzzle.html?v=1.1.0&roomId=" +
      encodeURIComponent(currentRoomId) +
      "&name=" +
      name;
    frame.style.cssText = "flex:1;width:100%;border:0;display:block;";

    overlay.appendChild(bar);
    overlay.appendChild(frame);
    document.body.appendChild(overlay);
    window.addEventListener("message", bridgeFromFrame);

    // Show "using the puzzle" in the room chat, the same way Talkoboard/Piano do.
    savedChatText = typeof selfRawText === "string" ? selfRawText : "";
    try {
      socket.emit("chat update", {
        diff: {
          type: "full-replace",
          text: "Using Puzzle. Open Apps (top right) > Puzzle to join!",
        },
      });
    } catch (_) {}
  }

  function closePuzzle() {
    if (!isOpen) return;
    isOpen = false;
    try {
      socket.emit("puzzle close");
    } catch (_) {}
    try {
      socket.emit("chat update", {
        diff: { type: "full-replace", text: savedChatText || "" },
      });
    } catch (_) {}
    window.removeEventListener("message", bridgeFromFrame);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    frame = null;
  }

  window.TalkomaticPuzzle = { open: openPuzzle, close: closePuzzle };
})();
