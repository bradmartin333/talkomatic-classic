// public/js/pong-client.js
// 1v1 pong overlay for rooms. Pairs with server/pong.js: the server owns the
// whole simulation; this client renders interpolated snapshots ~110 ms in the
// past (smooth under jitter) and draws YOUR paddle at your local target
// immediately, so your own controls feel instant.
//
// Follows the piano/talkoboard convention: the modal is built once and
// open()/close() only toggle it, so nothing leaks across opens.

class Pong {
  constructor(socket, userId, username) {
    this.socket = socket;
    this.userId = userId;
    this.username = username;

    this.isOpen = false;
    this.meta = null; // last "pong meta"
    this.snapshots = []; // ring of "pong state", oldest first
    this.clockOffset = 0; // serverTime - performance-now baseline
    this.offsetSamples = [];

    this.myTarget = 0.5; // 0..1, local paddle intent
    this.lastSentAt = 0;
    this.lastSentVal = -1;
    this.keys = { up: false, down: false };
    this.stageRect = null;
    this.frame = null;
    this.lastFrameAt = 0;
    this.lastScoreText = "";

    this.buildUI();
    this.bindSocket();

    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onPointer = this.onPointer.bind(this);
    this.onResize = this.onResize.bind(this);
    this.renderLoop = this.renderLoop.bind(this);
  }

  // ── UI ────────────────────────────────────────────────────────────────────

  buildUI() {
    const root = document.createElement("div");
    root.className = "pong-app";
    root.innerHTML = `
      <div class="pong-topbar">
        <div class="pong-title"><span class="pong-title-ico">🏓</span> PONG</div>
        <div class="pong-match">
          <span class="pong-chip pong-chip-left" id="pongLeftChip">Waiting...</span>
          <span class="pong-score" id="pongScore">0 : 0</span>
          <span class="pong-chip pong-chip-right" id="pongRightChip">Waiting...</span>
        </div>
        <div class="pong-actions">
          <span class="pong-watch" id="pongWatch"></span>
          <button class="pong-close" id="pongClose" aria-label="Close">×</button>
        </div>
      </div>
      <div class="pong-stage" id="pongStage">
        <canvas class="pong-canvas" id="pongCanvas"></canvas>
        <div class="pong-overlay" id="pongOverlay" style="display:none"></div>
      </div>
      <div class="pong-foot">
        <span id="pongHint">Move with the mouse, or W / S keys. Esc closes.</span>
        <span id="pongQueue"></span>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    this.stage = root.querySelector("#pongStage");
    this.canvas = root.querySelector("#pongCanvas");
    this.ctx = this.canvas.getContext("2d", { alpha: false });
    this.overlay = root.querySelector("#pongOverlay");
    this.scoreEl = root.querySelector("#pongScore");
    this.leftChip = root.querySelector("#pongLeftChip");
    this.rightChip = root.querySelector("#pongRightChip");
    this.watchEl = root.querySelector("#pongWatch");
    this.queueEl = root.querySelector("#pongQueue");
    this.hintEl = root.querySelector("#pongHint");
    root.querySelector("#pongClose").addEventListener("click", () => this.close());
  }

  bindSocket() {
    this.socket.on("pong state", (s) => {
      if (!this.isOpen || !s) return;
      const now = performance.now();
      // Clock offset: keep the smallest (least-delayed) recent sample
      this.offsetSamples.push(s.t - now);
      if (this.offsetSamples.length > 30) this.offsetSamples.shift();
      this.clockOffset = Math.max(...this.offsetSamples);
      this.snapshots.push(s);
      if (this.snapshots.length > 6) this.snapshots.shift();
      const scoreText = s.s[0] + " : " + s.s[1];
      if (scoreText !== this.lastScoreText) {
        this.lastScoreText = scoreText;
        this.scoreEl.textContent = scoreText;
      }
    });

    this.socket.on("pong meta", (m) => {
      if (!this.isOpen || !m) return;
      this.meta = m;
      this.updateBar();
    });

    this.socket.on("connect", () => {
      if (this.isOpen) this.socket.emit("pong open");
    });
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.meta = null;
    this.snapshots = [];
    this.offsetSamples = [];
    this.myTarget = 0.5;
    this.lastSentVal = -1;
    this.root.classList.add("show");
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("resize", this.onResize);
    this.stage.addEventListener("pointermove", this.onPointer);
    this.stage.addEventListener("pointerdown", this.onPointer);
    this.onResize();
    this.socket.emit("pong open");
    this.lastFrameAt = performance.now();
    this.frame = requestAnimationFrame(this.renderLoop);
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.socket.emit("pong close");
    this.root.classList.remove("show");
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("resize", this.onResize);
    this.stage.removeEventListener("pointermove", this.onPointer);
    this.stage.removeEventListener("pointerdown", this.onPointer);
    cancelAnimationFrame(this.frame);
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  amPlayer() {
    return this.meta && (this.meta.you === "left" || this.meta.you === "right");
  }

  onKeyDown(e) {
    if (!this.isOpen) return;
    if (e.key === "Escape") return this.close();
    if (e.key === "w" || e.key === "W" || e.key === "ArrowUp") this.keys.up = true;
    else if (e.key === "s" || e.key === "S" || e.key === "ArrowDown")
      this.keys.down = true;
    else return;
    e.preventDefault();
  }

  onKeyUp(e) {
    if (e.key === "w" || e.key === "W" || e.key === "ArrowUp") this.keys.up = false;
    if (e.key === "s" || e.key === "S" || e.key === "ArrowDown")
      this.keys.down = false;
  }

  onPointer(e) {
    if (!this.isOpen || !this.amPlayer()) return;
    if (!this.stageRect) this.stageRect = this.canvas.getBoundingClientRect();
    const r = this.stageRect;
    if (r.height > 0)
      this.myTarget = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    e.preventDefault();
  }

  onResize() {
    // DPR-aware backing store sized to the actual on-screen box (16:9 letterbox)
    const box = this.stage.getBoundingClientRect();
    const aspect = 1280 / 720;
    let w = box.width;
    let h = w / aspect;
    if (h > box.height) {
      h = box.height;
      w = h * aspect;
    }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.stageRect = null;
    requestAnimationFrame(() => {
      this.stageRect = this.canvas.getBoundingClientRect();
    });
  }

  maybeSendTarget(now) {
    if (!this.amPlayer()) return;
    if (now - this.lastSentAt < 33) return;
    if (Math.abs(this.myTarget - this.lastSentVal) < 0.002) return;
    this.lastSentAt = now;
    this.lastSentVal = this.myTarget;
    this.socket.emit("pong target", { y: this.myTarget });
  }

  // ── Interpolation ─────────────────────────────────────────────────────────

  serverNow() {
    return performance.now() + this.clockOffset;
  }

  // Render ~110ms in the past between the two snapshots straddling that time.
  sampled() {
    const snaps = this.snapshots;
    if (!snaps.length) return null;
    const target = this.serverNow() - 110;
    let a = snaps[0];
    let b = snaps[snaps.length - 1];
    for (let i = 0; i < snaps.length - 1; i++) {
      if (snaps[i].t <= target && snaps[i + 1].t >= target) {
        a = snaps[i];
        b = snaps[i + 1];
        break;
      }
    }
    const span = b.t - a.t;
    const k = span > 0 ? Math.max(0, Math.min(1, (target - a.t) / span)) : 1;
    const lerp = (x, y) => x + (y - x) * k;
    const latest = snaps[snaps.length - 1];
    return {
      st: latest.st,
      cd: latest.cd,
      nr: latest.nr,
      ball: [lerp(a.b[0], b.b[0]), lerp(a.b[1], b.b[1])],
      l: lerp(a.l, b.l),
      r: lerp(a.r, b.r),
      s: latest.s,
    };
  }

  // ── Render ────────────────────────────────────────────────────────────────

  renderLoop() {
    if (!this.isOpen) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;

    // Keyboard moves the local target continuously while held
    if (this.keys.up || this.keys.down) {
      const dir = (this.keys.down ? 1 : 0) - (this.keys.up ? 1 : 0);
      this.myTarget = Math.max(0, Math.min(1, this.myTarget + dir * dt * 1.5));
    }
    this.maybeSendTarget(now);

    this.draw();
    this.updateOverlay();
    this.frame = requestAnimationFrame(this.renderLoop);
  }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const sx = W / 1280;
    const sy = H / 720;
    const view = this.sampled();
    const meta = this.meta;

    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);

    // Center line
    ctx.strokeStyle = "#616161";
    ctx.lineWidth = Math.max(1, 2 * sx);
    ctx.setLineDash([10 * sy, 14 * sy]);
    ctx.beginPath();
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!view || !meta) return;

    const pw = meta.paddle.w * sx;
    const ph = meta.paddle.h * sy;
    const margin = meta.paddle.margin * sx;

    // Your own paddle renders at your local target for zero perceived lag
    let leftY = view.l;
    let rightY = view.r;
    const half = meta.paddle.h / 2;
    const predicted = Math.max(
      half,
      Math.min(720 - half, this.myTarget * 720),
    );
    if (meta.you === "left") leftY = predicted;
    if (meta.you === "right") rightY = predicted;

    ctx.fillStyle = "#ff9800";
    ctx.fillRect(margin, leftY * sy - ph / 2, pw, ph);
    ctx.fillStyle = "#01ffff";
    ctx.fillRect(W - margin - pw, rightY * sy - ph / 2, pw, ph);

    if (view.st === "playing") {
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(view.ball[0] * sx, view.ball[1] * sy, meta.ballR * sx, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Status overlays & top bar ─────────────────────────────────────────────

  chipHTML(info, side) {
    if (!info) return "Waiting...";
    let html = "";
    if (
      info.avatar &&
      /^\d{17,20}$/.test(info.avatar.id || "") &&
      /^(?:a_)?[a-f0-9]{32}$/i.test(info.avatar.hash || "")
    ) {
      html +=
        '<img class="pong-chip-pfp" alt="" src="https://cdn.discordapp.com/avatars/' +
        info.avatar.id + "/" + info.avatar.hash + '.webp?size=32">';
    }
    html += this.escape(info.name);
    if (this.meta && this.meta.you === side)
      html += ' <span class="pong-you">you</span>';
    return html;
  }

  escape(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  updateBar() {
    const m = this.meta;
    if (!m) return;
    this.leftChip.innerHTML = this.chipHTML(m.left, "left");
    this.rightChip.innerHTML = this.chipHTML(m.right, "right");
    this.watchEl.textContent = m.watching
      ? m.watching + " watching"
      : "";
    if (m.you === "spectator") {
      this.hintEl.textContent = "You are spectating. A seat opens when a round ends.";
      this.queueEl.textContent = m.queuePos
        ? "Your spot in line: #" + m.queuePos
        : "";
      this.stage.classList.remove("pong-playing");
    } else {
      this.hintEl.textContent =
        "First to " + (m.winScore || 5) + ". Move with the mouse, or W / S keys.";
      this.queueEl.textContent = "";
      this.stage.classList.add("pong-playing");
    }
  }

  updateOverlay() {
    const m = this.meta;
    const latest = this.snapshots[this.snapshots.length - 1];
    if (!m || !latest) {
      this.setOverlay("");
      return;
    }
    const sNow = this.serverNow();
    if (latest.st === "waiting") {
      this.setOverlay(
        '<div class="pong-card"><div class="pong-card-big">Waiting for an opponent</div>' +
          '<div class="pong-card-sub">The game starts when a second player opens Pong.</div></div>',
      );
    } else if (latest.st === "countdown") {
      const n = Math.max(1, Math.ceil((latest.cd - sNow) / 1000));
      this.setOverlay('<div class="pong-count">' + n + "</div>");
    } else if (latest.st === "over") {
      const w = m.winner || {};
      const secs = Math.max(0, Math.ceil((latest.nr - sNow) / 1000));
      const next = m.queue && m.queue.length ? m.queue[0] : null;
      this.setOverlay(
        '<div class="pong-card"><div class="pong-card-trophy">🏆</div>' +
          '<div class="pong-card-big">' + this.escape(w.name || "Player") + " wins!</div>" +
          '<div class="pong-card-score">' + latest.s[0] + " : " + latest.s[1] + "</div>" +
          '<div class="pong-card-sub">Next round in ' + secs + "s" +
          (next ? " · Up next: " + this.escape(next) : "") +
          "</div></div>",
      );
    } else {
      this.setOverlay("");
    }
  }

  setOverlay(html) {
    if (this._overlayHTML === html) return;
    this._overlayHTML = html;
    if (!html) {
      this.overlay.style.display = "none";
    } else {
      this.overlay.innerHTML = html;
      this.overlay.style.display = "flex";
    }
  }
}

window.Pong = Pong;
