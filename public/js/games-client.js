// public/js/games-client.js
// Mini games panel. Talks to server/games over the room socket, no second
// connection.
//
// Two views. The floor picks a game and shows what is happening in the room.
// The game view is a split: the board on the left, players and chat on the
// right, stacking on a phone.
//
// Boards are objects with mount/update so a state push never rebuilds the DOM
// under a focused input or wipes the drawing canvas. The chat log and the
// board both patch in place for the same reason.

(function () {
  const S = window.socket;
  if (!S) return;

  const el = (t, p, c) =>
    window.StaffUI ? window.StaffUI.el(t, p, c) : basicEl(t, p, c);

  function basicEl(tag, props, children) {
    const e = document.createElement(tag);
    if (props)
      for (const k in props) {
        if (k === "class") e.className = props[k];
        else if (k === "text") e.textContent = props[k];
        else if (k.startsWith("on") && typeof props[k] === "function")
          e.addEventListener(k.slice(2).toLowerCase(), props[k]);
        else if (props[k] != null) e.setAttribute(k, props[k]);
      }
    if (children)
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null) return;
        e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
    return e;
  }

  function toast(msg, type) {
    if (window.StaffUI) window.StaffUI.toast(msg, { type: type || "info" });
    else if (window.toastr)
      window.toastr[type === "error" ? "error" : "info"](msg);
  }

  const DRAW_COLORS = [
    "#1b1b1b", "#e53935", "#fb8c00", "#fdd835",
    "#43a047", "#1e88e5", "#8e24aa", "#6d4c41",
  ];
  const BRUSHES = [3, 8, 18];

  const ID_RE = /^[0-9]{5,25}$/;
  const HASH_RE = /^[a-f0-9_]{8,64}$/i;

  // A game icon is { emoji }, { fa } or { image }, so a new game can use
  // whichever it has to hand.
  function iconNode(icon, cls) {
    const wrap = el("span", { class: cls || "gm-icon" });
    if (!icon) return wrap;
    if (icon.image) {
      const img = el("img", { alt: "" });
      img.src = icon.image;
      img.onerror = () => img.remove();
      wrap.appendChild(img);
    } else if (icon.fa) {
      wrap.appendChild(el("i", { class: icon.fa }));
    } else {
      wrap.appendChild(document.createTextNode(icon.emoji || "🎲"));
    }
    return wrap;
  }

  // Staff flair, matching the room's own badges. Roles are stamped by the
  // server from the room record, so these cannot be faked from a client.
  function badgeFor(role) {
    if (role === "dev") {
      const b = el("span", { class: "gm-staff gm-staff-dev", title: "Talkomatic developer" });
      const crown = el("img", { alt: "" });
      crown.src = "images/icons/crown.gif";
      crown.onerror = () => crown.remove();
      b.appendChild(crown);
      b.appendChild(document.createTextNode("DEV"));
      return b;
    }
    if (role === "mod")
      return el("span", { class: "gm-staff gm-staff-mod", title: "Moderator", text: "MOD" });
    if (role === "jr")
      return el("span", { class: "gm-staff gm-staff-jr", title: "Junior moderator", text: "JR MOD" });
    return null;
  }

  function avatarNode(av, small) {
    if (!av || !ID_RE.test(av.id || "") || !HASH_RE.test(av.hash || "")) return null;
    const img = el("img", { class: "gm-pfp" + (small ? " gm-pfp-sm" : ""), alt: "" });
    img.src =
      "https://cdn.discordapp.com/avatars/" + av.id + "/" + av.hash +
      ".webp?size=64" + (av.animated ? "&animated=true" : "");
    img.onerror = () => img.remove();
    return img;
  }

  // Shared loading state. Some of the standalone games pull a few hundred KB
  // of images and audio, so a blank panel reads as broken.
  function loadingNode(text, sub) {
    const box = el("div", { class: "gm-loading" });
    box.appendChild(el("div", { class: "gm-spinner" }));
    box.appendChild(el("div", { class: "gm-loading-text", text: text || "Loading" }));
    if (sub) box.appendChild(el("div", { class: "gm-loading-sub", text: sub }));
    return box;
  }

  function trophyNode(rank) {
    if (!rank || rank < 1 || rank > 3) return null;
    const img = el("img", { class: "gm-trophy", alt: "" });
    img.src =
      "images/icons/trophy-" +
      (rank === 1 ? "gold" : rank === 2 ? "silver" : "bronze") + ".png";
    img.onerror = () => img.remove();
    return img;
  }

  let overlay = null;
  let bodyEl = null;
  let stripEl = null;
  let statsEl = null;
  let isOpen = false;

  let catalog = [];
  let floor = { tables: [], counts: {}, pools: {}, myQueue: {}, myTables: {} };
  let view = { name: "floor", tableId: null };
  let detail = null;
  let roomUsers = [];
  let board = null;
  let boardKey = "";
  let side = null; // players + chat controller for the open game
  let clockTimer = null;
  let cleanupSolo = null; // timers for a solo game's loading state

  function myId() {
    return typeof currentUserId !== "undefined" ? currentUserId : "";
  }
  function gameById(id) {
    return catalog.find((g) => g.id === id) || null;
  }
  function nameOf(id) {
    const g = gameById(id);
    return g ? g.name : id;
  }

  // ── Shell ─────────────────────────────────────────────────────────────────

  function build() {
    overlay = el("div", { class: "gm-overlay", id: "gamesOverlay" });

    const head = el("div", { class: "gm-head" });
    const titleWrap = el("div", { class: "gm-title-wrap" });
    titleWrap.appendChild(
      el("div", { class: "gm-title" }, [
        el("i", { class: "fas fa-gamepad" }),
        "Mini Games",
      ]),
    );
    titleWrap.appendChild(
      el("div", {
        class: "gm-sub",
        text: "Play with the room. Watch, chat, and jump in when there is space.",
      }),
    );

    statsEl = el("div", { class: "gm-stats" });
    head.appendChild(titleWrap);
    head.appendChild(statsEl);
    head.appendChild(
      el("button", {
        class: "gm-close",
        "aria-label": "Close mini games",
        onclick: closePanel,
        text: "×",
      }),
    );

    stripEl = el("div", { class: "gm-strip", text: "Choose a game" });
    bodyEl = el("div", { class: "gm-body" });

    overlay.appendChild(el("div", { class: "gm-modal" }, [head, stripEl, bodyEl]));
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) closePanel();
    });
    document.body.appendChild(overlay);
  }

  function openPanel() {
    if (!overlay) build();
    isOpen = true;
    overlay.classList.add("show");
    S.emit("games open");
    startClock();
    render();
  }

  function closePanel() {
    isOpen = false;
    if (overlay) overlay.classList.remove("show");
    stopClock();
    teardownGameView();
  }

  function teardownGameView() {
    if (cleanupSolo) {
      cleanupSolo();
      cleanupSolo = null;
    }
    if (board && board.destroy) board.destroy();
    board = null;
    boardKey = "";
    side = null;
  }

  function startClock() {
    if (clockTimer) return;
    clockTimer = setInterval(() => {
      if (isOpen) paintClocks();
    }, 250);
  }
  function stopClock() {
    if (clockTimer) clearInterval(clockTimer);
    clockTimer = null;
  }

  function secsLeft(deadline) {
    if (!deadline) return null;
    return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  }

  function paintClocks() {
    if (!overlay) return;
    overlay.querySelectorAll("[data-deadline]").forEach((n) => {
      const left = secsLeft(Number(n.dataset.deadline));
      if (left === null) return;
      n.textContent = n.dataset.prefix
        ? n.dataset.prefix + " " + left + "s"
        : left + "s";
      n.classList.toggle("gm-urgent", left <= 5);
    });
    overlay.querySelectorAll("[data-bar-end]").forEach((n) => {
      const end = Number(n.dataset.barEnd);
      if (!end) return;
      const span = Number(n.dataset.barSpan) || 1;
      const pct = Math.max(0, Math.min(100, ((end - Date.now()) / span) * 100));
      n.style.width = pct + "%";
      n.classList.toggle("gm-bar-low", pct < 20);
    });
  }

  function render() {
    if (!isOpen || !bodyEl) return;
    if (view.name === "solo") return; // the frame owns the body until they go back
    if (view.name === "game" && detail && detail.id === view.tableId)
      renderGame();
    else renderFloor();
    paintClocks();
  }

  // ── Floor ─────────────────────────────────────────────────────────────────

  function renderStats() {
    statsEl.textContent = "";
    let playing = 0;
    let waiting = 0;
    Object.keys(floor.counts || {}).forEach((k) => {
      playing += floor.counts[k].playing || 0;
      waiting += floor.counts[k].waiting || 0;
    });
    const live = floor.tables.filter((t) => t.state === "playing").length;
    statsEl.appendChild(
      el("span", { class: "gm-chip gm-chip-live" }, [
        el("i", { class: "fas fa-circle-play" }),
        live + (live === 1 ? " game on" : " games on"),
      ]),
    );
    statsEl.appendChild(
      el("span", { class: "gm-chip" }, [
        el("i", { class: "fas fa-users" }),
        playing + " playing",
      ]),
    );
    if (waiting)
      statsEl.appendChild(
        el("span", { class: "gm-chip gm-chip-queue" }, [
          el("i", { class: "fas fa-user-clock" }),
          waiting + " up next",
        ]),
      );
  }

  function renderFloor() {
    teardownGameView();
    renderStats();
    stripEl.textContent = "Choose a game";
    bodyEl.textContent = "";
    bodyEl.className = "gm-body";

    const grid = el("div", { class: "gm-games" });
    catalog.filter((g) => !g.external).forEach((g) => grid.appendChild(gameCard(g)));
    bodyEl.appendChild(grid);

    const solos = catalog.filter((g) => g.external);
    if (solos.length) {
      bodyEl.appendChild(section("fa-user", "Play on your own"));
      const sgrid = el("div", { class: "gm-games" });
      solos.forEach((g) => sgrid.appendChild(soloCard(g)));
      bodyEl.appendChild(sgrid);
    }

    const live = floor.tables.filter((t) => t.state === "playing");
    const waiting = floor.tables.filter((t) => t.state !== "playing");

    if (live.length) {
      bodyEl.appendChild(
        section("fa-circle-play", "Happening now", live.length + ""),
      );
      const list = el("div", { class: "gm-rows" });
      live.forEach((t) => list.appendChild(gameRow(t)));
      bodyEl.appendChild(list);
    }
    if (waiting.length) {
      bodyEl.appendChild(section("fa-hourglass-half", "Waiting to start"));
      const list = el("div", { class: "gm-rows" });
      waiting.forEach((t) => list.appendChild(gameRow(t)));
      bodyEl.appendChild(list);
    }
    if (!live.length && !waiting.length) {
      bodyEl.appendChild(
        el("div", { class: "gm-empty" }, [
          el("i", { class: "fas fa-dice" }),
          el("p", { text: "Nothing running yet. Start one above and the room can join you." }),
        ]),
      );
    }
  }

  function section(icon, label, badge) {
    const s = el("div", { class: "gm-section" }, [
      el("i", { class: "fas " + icon }),
      label,
    ]);
    if (badge) s.appendChild(el("span", { class: "gm-section-badge", text: badge }));
    return s;
  }

  // Standalone games under public/games. Same three row card as the rest.
  function soloCard(g) {
    const card = el("div", { class: "gm-card gm-card-solo" });

    const top = el("div", { class: "gm-card-top" });
    top.appendChild(iconNode(g.icon, "gm-card-icon"));
    const text = el("div", { class: "gm-card-text" });
    const nameRow = el("div", { class: "gm-card-name" }, g.name);
    if (g.howTo && g.howTo.length)
      nameRow.appendChild(
        el("button", {
          class: "gm-help",
          title: "How to play",
          "aria-label": "How to play " + g.name,
          onclick: (e) => { e.stopPropagation(); showHowTo(g); },
        }, el("i", { class: "fas fa-circle-question" })),
      );
    text.appendChild(nameRow);
    text.appendChild(el("div", { class: "gm-card-blurb", text: g.blurb }));
    top.appendChild(text);
    card.appendChild(top);

    const mid = el("div", { class: "gm-card-mid" });
    mid.appendChild(
      el("button", { class: "gm-btn gm-btn-primary", text: "Play", onclick: () => openSolo(g) }),
    );
    mid.appendChild(
      el("div", { class: "gm-card-who" }, [
        el("span", { class: "gm-dot" }),
        el("span", { text: "Play on your own, any time" }),
      ]),
    );
    card.appendChild(mid);

    const foot = el("div", { class: "gm-card-foot" });
    foot.appendChild(
      el("div", { class: "gm-card-tags" }, el("span", { class: "gm-tag", text: "Solo" })),
    );
    foot.appendChild(
      el("button", {
        class: "gm-btn gm-btn-ghost gm-card-invite",
        text: "Open in a tab",
        onclick: () => window.open(g.url, "_blank", "noopener,noreferrer"),
      }),
    );
    card.appendChild(foot);
    return card;
  }

  function showHowTo(g) {
    const body = el("div", { class: "gm-howto" });
    (g.howTo || []).forEach((line, i) => {
      body.appendChild(
        el("div", { class: "gm-howto-step" }, [
          el("span", { class: "gm-howto-n", text: String(i + 1) }),
          el("span", { text: line }),
        ]),
      );
    });
    if (window.StaffUI && window.StaffUI.modal)
      window.StaffUI.modal({
        title: "How to play " + g.name,
        icon: '<i class="fas fa-circle-question"></i>',
        body,
        actions: [{ label: "Got it", kind: "primary" }],
      });
  }

  // Solo games run in their own frame inside the panel, so the room socket and
  // the chat behind it stay put.
  function openSolo(g) {
    teardownGameView();
    view = { name: "solo", tableId: null };
    stripEl.textContent = g.name;
    bodyEl.textContent = "";
    bodyEl.className = "gm-body gm-body-solo";

    const bar = el("div", { class: "gm-gamebar" });
    bar.appendChild(
      el("button", { class: "gm-btn gm-btn-ghost gm-back", onclick: backToFloor }, [
        el("i", { class: "fas fa-chevron-left" }),
        " Games",
      ]),
    );
    bar.appendChild(el("div", { class: "gm-turnline", text: g.blurb }));
    const acts = el("div", { class: "gm-gameacts" });
    if (g.howTo && g.howTo.length)
      acts.appendChild(
        el("button", { class: "gm-btn", text: "How to play", onclick: () => showHowTo(g) }),
      );
    acts.appendChild(
      el("button", {
        class: "gm-btn",
        text: "Open in a tab",
        onclick: () => window.open(g.url, "_blank", "noopener,noreferrer"),
      }),
    );
    bar.appendChild(acts);
    bodyEl.appendChild(bar);

    const frame = el("iframe", {
      class: "gm-solo-frame",
      title: g.name,
      src: g.url,
      allow: "autoplay",
    });
    const loading = loadingNode("Loading " + g.name);
    const wrap = el("div", { class: "gm-solo-wrap" }, [loading, frame]);
    frame.classList.add("gm-hidden");
    let done = false;
    const ready = () => {
      if (done) return;
      done = true;
      if (cleanupSolo) cleanupSolo();
      loading.remove();
      frame.classList.remove("gm-hidden");
    };
    frame.addEventListener("load", ready);
    // The load event waits on every last image and script, and some of these
    // games pull a big library from a CDN. Watch readyState too so the spinner
    // clears the moment the game is actually usable.
    const poll = setInterval(() => {
      if (done) return clearInterval(poll);
      try {
        if (frame.contentDocument && frame.contentDocument.readyState === "complete")
          ready();
      } catch (_) {}
    }, 150);
    // Say something rather than sitting on a bare spinner.
    const slow = setTimeout(() => {
      if (done) return;
      const sub = loading.querySelector(".gm-loading-sub");
      const msg = "Fetching this game's pictures and sounds.";
      if (sub) sub.textContent = msg;
      else loading.appendChild(el("div", { class: "gm-loading-sub", text: msg }));
    }, 2500);
    // Belt and braces: never leave a spinner up for ever.
    const bail = setTimeout(ready, 15000);
    cleanupSolo = () => {
      clearInterval(poll);
      clearTimeout(slow);
      clearTimeout(bail);
    };
    bodyEl.appendChild(wrap);
  }

  // One column, three rows: who it is, what you do, what it costs you.
  // The icon sits inline with the title rather than owning a column, which is
  // what squashed the text into a ribbon before.
  function gameCard(g) {
    const c = (floor.counts && floor.counts[g.id]) || {
      playing: 0, waiting: 0, live: 0, names: [],
    };
    const myPos = floor.myQueue[g.id] || 0;
    const myGame = floor.myTables[g.id] || null;

    const card = el("div", {
      class: "gm-card" + (myGame ? " gm-card-mine" : ""),
    });

    // Row 1: icon, name, description
    const top = el("div", { class: "gm-card-top" });
    top.appendChild(iconNode(g.icon, "gm-card-icon"));
    const text = el("div", { class: "gm-card-text" });
    const nameRow = el("div", { class: "gm-card-name" }, g.name);
    if (g.howTo && g.howTo.length)
      nameRow.appendChild(
        el("button", {
          class: "gm-help",
          "aria-label": "How to play " + g.name,
          title: "How to play",
          onclick: (e) => {
            e.stopPropagation();
            showHowTo(g);
          },
        }, el("i", { class: "fas fa-circle-question" })),
      );
    text.appendChild(nameRow);
    text.appendChild(el("div", { class: "gm-card-blurb", text: g.blurb }));
    top.appendChild(text);
    card.appendChild(top);

    // Row 2: the action, and who is in there right now
    const mid = el("div", { class: "gm-card-mid" });
    if (myGame) {
      mid.appendChild(
        el("button", {
          class: "gm-btn gm-btn-primary",
          text: "Back to your game",
          onclick: () => openGame(myGame),
        }),
      );
    } else if (myPos) {
      mid.appendChild(
        el("button", {
          class: "gm-btn",
          text: "Leave the line",
          onclick: () => S.emit("games queue leave", { type: g.id }),
        }),
      );
    } else {
      mid.appendChild(
        el("button", {
          class: "gm-btn gm-btn-primary",
          text: c.playing ? "Join in" : "Start a game",
          onclick: () => S.emit("games queue join", { type: g.id }),
        }),
      );
    }

    const line = el("div", { class: "gm-card-who" });
    if (myPos) {
      line.appendChild(el("span", { class: "gm-dot gm-dot-wait" }));
      line.appendChild(
        el("b", {
          text: myPos === 1 ? "You are next up" : "You are #" + myPos + " in line",
        }),
      );
    } else if (c.playing) {
      line.appendChild(el("span", { class: "gm-dot gm-dot-live" }));
      line.appendChild(
        el("b", {
          text: c.playing + (c.playing === 1 ? " playing" : " playing"),
        }),
      );
      if (c.names.length)
        line.appendChild(
          el("span", {
            class: "gm-card-names",
            text:
              c.names.slice(0, 2).join(", ") +
              (c.playing > 2 ? " +" + (c.playing - 2) : ""),
          }),
        );
    } else if (c.waiting) {
      line.appendChild(el("span", { class: "gm-dot gm-dot-wait" }));
      line.appendChild(el("b", { text: c.waiting + " waiting to start" }));
    } else {
      line.appendChild(el("span", { class: "gm-dot" }));
      line.appendChild(el("span", { text: "Nobody playing yet" }));
    }
    mid.appendChild(line);
    card.appendChild(mid);

    // Row 3: the small print, and inviting somebody by name
    const foot = el("div", { class: "gm-card-foot" });
    const tags = el("div", { class: "gm-card-tags" });
    tags.appendChild(
      el("span", {
        class: "gm-tag",
        text:
          g.minPlayers === g.maxPlayers
            ? g.minPlayers + " players"
            : "2 to " + g.maxPlayers + " players",
      }),
    );
    tags.appendChild(
      el("span", {
        class: "gm-tag",
        text: g.winnerStays ? "Winner plays on" : "Everyone at once",
      }),
    );
    foot.appendChild(tags);
    if (g.turnBased && g.maxPlayers === 2 && !myGame)
      foot.appendChild(
        el("button", {
          class: "gm-btn gm-btn-ghost gm-card-invite",
          text: "Invite someone",
          onclick: () => showChallengePicker(g),
        }),
      );
    card.appendChild(foot);
    return card;
  }

  function gameRow(t) {
    const g = gameById(t.type);
    const seated = t.seats.some((s) => s.userId === myId());
    const row = el("div", {
      class: "gm-row gm-row-" + t.state + (seated ? " gm-row-mine" : ""),
    });
    row.appendChild(iconNode(g && g.icon, "gm-row-icon"));

    const mid = el("div", { class: "gm-row-mid" });
    const title = el("div", { class: "gm-row-title" });
    title.appendChild(el("b", { text: g ? g.name : t.type }));
    if (t.state === "playing")
      title.appendChild(el("span", { class: "gm-live", text: "LIVE" }));
    if (seated) title.appendChild(el("span", { class: "gm-yours", text: "YOURS" }));
    mid.appendChild(title);

    // Names, not "seats". A person reads names.
    const who = t.seats.map((s) => s.username);
    let line;
    if (!who.length) line = "Waiting for a player";
    else if (t.reservedFor)
      line = who[0] + " invited " + t.reservedFor.username;
    else if (t.state === "playing")
      line = g && g.maxPlayers === 2 ? who.join(" vs ") : who.join(", ");
    else if (who.length === 1) line = who[0] + " is waiting for someone to join";
    else line = who.join(", ") + " are waiting to start";
    mid.appendChild(el("div", { class: "gm-row-who", text: line }));

    const meta = el("div", { class: "gm-row-meta" });
    if (t.state === "open" && t.openDeadline)
      meta.appendChild(
        el("span", {
          class: "gm-count",
          "data-deadline": String(t.openDeadline),
          "data-prefix": "starts in",
        }),
      );
    if (t.streak && t.streak.n > 1)
      meta.appendChild(
        el("span", {
          class: "gm-streak",
          text: "🔥 " + t.streak.username + " has won " + t.streak.n + " in a row",
        }),
      );
    if (t.spectators)
      meta.appendChild(
        el("span", {
          text:
            t.spectators + (t.spectators === 1 ? " watching" : " watching"),
        }),
      );
    if (meta.childNodes.length) mid.appendChild(meta);
    row.appendChild(mid);

    const acts = el("div", { class: "gm-row-acts" });
    if (seated) {
      acts.appendChild(
        el("button", {
          class: "gm-btn gm-btn-primary",
          text: "Open",
          onclick: () => openGame(t.id),
        }),
      );
    } else if (t.canJoin) {
      acts.appendChild(
        el("button", {
          class: "gm-btn gm-btn-primary",
          text: t.state === "playing" ? "Join in" : "Play",
          onclick: () => S.emit("games join table", { tableId: t.id }),
        }),
      );
    }
    if (!seated) {
      acts.appendChild(
        el("button", {
          class: "gm-btn gm-btn-ghost",
          text: "Watch",
          onclick: () => {
            S.emit("games spectate", { tableId: t.id, on: true });
            openGame(t.id);
          },
        }),
      );
    }
    row.appendChild(acts);
    return row;
  }

  function showChallengePicker(g) {
    const others = roomUsers.filter((u) => u.id !== myId());
    if (!others.length) return toast("Nobody else is in the room yet.", "info");
    const list = el("div", { class: "gm-picker" });
    let handle = null;
    others.forEach((u) => {
      list.appendChild(
        el("button", {
          class: "gm-picker-btn",
          text: u.username,
          onclick: () => {
            S.emit("games challenge", { targetUserId: u.id, type: g.id });
            if (handle && handle.close) handle.close();
          },
        }),
      );
    });
    if (window.StaffUI && window.StaffUI.modal) {
      handle = window.StaffUI.modal({
        title: "Who do you want to play " + g.name + " with?",
        body: list,
        actions: [{ label: "Cancel" }],
      });
    } else bodyEl.appendChild(list);
  }

  // ── Game view ─────────────────────────────────────────────────────────────

  function openGame(tableId) {
    view = { name: "game", tableId };
    if (!detail || detail.id !== tableId) detail = null;
    const t = floor.tables.find((x) => x.id === tableId);
    if (t) stripEl.textContent = nameOf(t.type);
    if (detail) return render();
    teardownGameView();
    bodyEl.textContent = "";
    bodyEl.className = "gm-body";
    bodyEl.appendChild(
      loadingNode(
        t ? "Opening " + nameOf(t.type) : "Opening",
        "Waiting for the board",
      ),
    );
  }

  function backToFloor() {
    if (detail && detail.spectating)
      S.emit("games spectate", { tableId: detail.id, on: false });
    view = { name: "floor", tableId: null };
    detail = null;
    render();
  }

  function renderGame() {
    const t = detail;
    renderStats();
    stripEl.textContent = nameOf(t.type);

    const key = t.id + ":" + t.type;
    if (key !== boardKey) {
      teardownGameView();
      bodyEl.textContent = "";
      bodyEl.className = "gm-body gm-body-game";

      const bar = el("div", { class: "gm-gamebar" });
      bar.appendChild(
        el("button", { class: "gm-btn gm-btn-ghost gm-back", onclick: backToFloor }, [
          el("i", { class: "fas fa-chevron-left" }),
          " Games",
        ]),
      );
      bar.appendChild(el("div", { class: "gm-turnline", id: "gmTurn" }));
      const help = gameById(t.type);
      if (help && help.howTo && help.howTo.length)
        bar.appendChild(
          el("button", {
            class: "gm-help gm-help-bar",
            title: "How to play",
            "aria-label": "How to play " + help.name,
            onclick: () => showHowTo(help),
          }, el("i", { class: "fas fa-circle-question" })),
        );
      bar.appendChild(el("div", { class: "gm-gameacts", id: "gmActs" }));
      bodyEl.appendChild(bar);

      bodyEl.appendChild(el("div", { class: "gm-banner", id: "gmBanner" }));

      const split = el("div", { class: "gm-split" });
      const main = el("div", { class: "gm-main" });
      main.appendChild(el("div", { class: "gm-waitslot", id: "gmWait" }));
      const sideEl = el("div", { class: "gm-side" });
      split.appendChild(main);
      split.appendChild(sideEl);
      bodyEl.appendChild(split);

      board = BOARDS[t.type] ? BOARDS[t.type]() : null;
      if (board) board.mount(main);
      side = makeSide();
      side.mount(sideEl);
      boardKey = key;
    }

    paintBanner(t);
    paintWaiting(t);
    paintTurn(t);
    paintActs(t);
    if (board) board.update(t);
    if (side) side.update(t);
  }

  function paintWaiting(t) {
    const slot = overlay.querySelector("#gmWait");
    if (!slot) return;
    const main = slot.parentNode;
    slot.textContent = "";
    // Only when the board itself cannot run yet, never mid-match.
    const short = t.state === "open" && !t.game && !t.reservedFor;
    main.classList.toggle("gm-main-waiting", short);
    if (short) slot.appendChild(waitingPanel(t));
  }

  // The result, said plainly and at full width. Nobody should have to work out
  // whether they won from a timer in the corner.
  function paintBanner(t) {
    const host = overlay.querySelector("#gmBanner");
    if (!host) return;
    host.textContent = "";
    const o = t.outcome;
    if (!o) {
      host.className = "gm-banner";
      return;
    }
    host.className = "gm-banner show gm-banner-" + o.kind;

    const icons = {
      win: "fa-trophy",
      loss: "fa-circle-xmark",
      draw: "fa-handshake",
      watched: "fa-flag-checkered",
      over: "fa-flag-checkered",
    };
    host.appendChild(
      el("i", { class: "fas " + (icons[o.kind] || "fa-flag-checkered") }),
    );
    const txt = el("div", { class: "gm-banner-text" });
    txt.appendChild(el("div", { class: "gm-banner-head", text: o.headline }));
    if (o.detail)
      txt.appendChild(el("div", { class: "gm-banner-sub", text: o.detail }));
    host.appendChild(txt);

    if (t.rotateAt) {
      const g = gameById(t.type);
      const nextText = g && g.winnerStays ? "next game in" : "back to games in";
      host.appendChild(
        el("div", {
          class: "gm-banner-next gm-count",
          "data-deadline": String(t.rotateAt),
          "data-prefix": nextText,
        }),
      );
    }
  }

  function paintTurn(t) {
    const host = overlay.querySelector("#gmTurn");
    if (!host) return;
    host.textContent = "";
    if (t.state === "finished") return; // the banner is saying it instead
    const g = t.game || {};

    if (t.state === "open") {
      if (t.reservedFor)
        host.appendChild(
          el("span", { text: "Waiting for " + t.reservedFor.username + " to answer" }),
        );
      else if (t.openDeadline) {
        host.appendChild(el("span", { text: "Starting soon" }));
        host.appendChild(
          el("span", {
            class: "gm-count gm-count-pill",
            "data-deadline": String(t.openDeadline),
          }),
        );
      } else
        host.appendChild(
          el("span", { text: "Waiting for another player to join" }),
        );
      return;
    }

    if (t.turnDeadline && g.turnUserId) {
      const yours = g.turnUserId === myId();
      const who = t.seats.find((s) => s.userId === g.turnUserId);
      host.appendChild(
        el("span", {
          class: yours ? "gm-turn gm-turn-mine" : "gm-turn",
          text: yours
            ? "Your move"
            : "Waiting on " + (who ? who.username : "your opponent"),
        }),
      );
      host.appendChild(
        el("span", {
          class: "gm-count gm-count-pill",
          "data-deadline": String(t.turnDeadline),
        }),
      );
    }
  }

  function paintActs(t) {
    const host = overlay.querySelector("#gmActs");
    if (!host) return;
    host.textContent = "";

    if (t.seated && t.state === "finished") {
      const wants = t.rematch.indexOf(myId()) >= 0;
      host.appendChild(
        el("button", {
          class: wants ? "gm-btn gm-btn-primary" : "gm-btn",
          text: wants
            ? "Rematch asked " + t.rematch.length + "/" + t.seats.length
            : "Play again",
          onclick: () => S.emit("games rematch", { tableId: t.id }),
        }),
      );
    }
    if (t.seated) {
      host.appendChild(
        el("button", {
          class: "gm-btn gm-btn-danger",
          text: t.state === "playing" ? "Give up" : "Leave game",
          onclick: () => {
            S.emit("games leave", { tableId: t.id });
            backToFloor();
          },
        }),
      );
    } else {
      if (t.canJoin)
        host.appendChild(
          el("button", {
            class: "gm-btn gm-btn-primary",
            text: "Join in",
            onclick: () => S.emit("games join table", { tableId: t.id }),
          }),
        );
      host.appendChild(
        el("button", { class: "gm-btn", text: "Stop watching", onclick: backToFloor }),
      );
    }
  }

  // Shown in place of the board while a game is short of players, so somebody
  // who started one sits at their own board instead of watching a queue number.
  function waitingPanel(t) {
    const g = gameById(t.type);
    const box = el("div", { class: "gm-waiting" });
    box.appendChild(el("div", { class: "gm-waiting-pulse" }));
    box.appendChild(
      el("div", { class: "gm-waiting-head", text: "Waiting for someone to join" }),
    );
    const need = g && g.maxPlayers === 2 ? "one more player" : "another player";
    box.appendChild(
      el("div", {
        class: "gm-waiting-sub",
        text:
          "Your board is set up and needs " + need +
          ". Anyone in the room can jump in, or you can ask somebody by name.",
      }),
    );
    const acts = el("div", { class: "gm-waiting-acts" });
    if (g && g.turnBased && g.maxPlayers === 2)
      acts.appendChild(
        el("button", {
          class: "gm-btn gm-btn-primary",
          text: "Challenge someone",
          onclick: () => showChallengePicker(g),
        }),
      );
    acts.appendChild(
      el("button", {
        class: "gm-btn",
        text: "Leave",
        onclick: () => {
          S.emit("games leave", { tableId: t.id });
          backToFloor();
        },
      }),
    );
    box.appendChild(acts);
    if (t.streak && t.streak.n > 1)
      box.appendChild(
        el("div", {
          class: "gm-waiting-streak",
          text: "You are on " + t.streak.n + " wins in a row.",
        }),
      );
    return box;
  }

  // ── Side panel: who is here, and the chat ─────────────────────────────────

  function makeSide() {
    let root, playersEl, logEl, form, input, typingEl, countEl;
    let lastChatId = 0;
    let typingSentAt = 0;

    function atBottom() {
      return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 40;
    }

    function addLine(m) {
      const stick = atBottom();
      let node;
      if (m.kind === "system") {
        node = el("div", { class: "gm-chat-sys", text: m.text });
      } else {
        node = el("div", {
          class:
            "gm-chat-line" +
            (m.userId === myId() ? " gm-chat-mine" : "") +
            (m.watching ? " gm-chat-watch" : ""),
        });
        const pfp = avatarNode(m.avatar, true);
        if (pfp) node.appendChild(pfp);
        const badge = badgeFor(m.role);
        if (badge) node.appendChild(badge);
        const who = el("span", { class: "gm-chat-who", text: m.username });
        if (m.watching)
          who.appendChild(el("i", { class: "fas fa-eye", title: "Watching" }));
        node.appendChild(who);
        node.appendChild(el("span", { class: "gm-chat-text", text: m.text }));
      }
      logEl.appendChild(node);
      while (logEl.childNodes.length > 120) logEl.removeChild(logEl.firstChild);
      if (stick) logEl.scrollTop = logEl.scrollHeight;
    }

    return {
      mount(host) {
        root = el("div", { class: "gm-sidepanel" });

        const ph = el("div", { class: "gm-side-head" }, [
          el("i", { class: "fas fa-users" }),
          el("span", { text: "In this game" }),
        ]);
        countEl = el("span", { class: "gm-side-count" });
        ph.appendChild(countEl);
        root.appendChild(ph);

        playersEl = el("div", { class: "gm-players" });
        root.appendChild(playersEl);

        root.appendChild(
          el("div", { class: "gm-side-head" }, [
            el("i", { class: "fas fa-comments" }),
            el("span", { text: "Game chat" }),
          ]),
        );
        logEl = el("div", { class: "gm-chat-log" });
        root.appendChild(logEl);

        typingEl = el("div", { class: "gm-chat-typing" });
        root.appendChild(typingEl);

        input = el("input", {
          class: "gm-chat-input",
          type: "text",
          maxlength: "200",
          placeholder: "Say something",
          autocomplete: "off",
        });
        input.addEventListener("input", () => {
          const now = Date.now();
          if (input.value && now - typingSentAt > 2000) {
            typingSentAt = now;
            S.emit("games typing", { tableId: detail.id, on: true });
          }
        });
        form = el("form", { class: "gm-chat-form" }, [
          input,
          el("button", {
            class: "gm-btn gm-btn-primary gm-chat-send",
            type: "submit",
            "aria-label": "Send",
          }, el("i", { class: "fas fa-paper-plane" })),
        ]);
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const v = input.value.trim();
          if (!v) return;
          S.emit("games chat", { tableId: detail.id, text: v });
          S.emit("games typing", { tableId: detail.id, on: false });
          typingSentAt = 0;
          input.value = "";
        });
        root.appendChild(form);
        host.appendChild(root);
      },

      // Appended live so the log never jumps while you are reading it.
      relay(payload) {
        if (payload.kind === "chat" && payload.message) {
          if (payload.message.id <= lastChatId) return;
          lastChatId = payload.message.id;
          addLine(payload.message);
        } else if (payload.kind === "typing") {
          paintTyping(payload.users || []);
        }
      },

      update(t) {
        const g = t.game || {};
        // Player list. Draw & Guess carries its own richer roster.
        const list =
          g.players && g.players.length
            ? g.players
            : t.seats.map((s) => ({ userId: s.userId, username: s.username }));
        countEl.textContent =
          list.length + (t.spectators ? " + " + t.spectators + " watching" : "");

        playersEl.textContent = "";
        list.forEach((p) => {
          const seat = t.seats.find((s) => s.userId === p.userId);
          const seatedPlayer = !!seat;
          const row = el("div", {
            class:
              "gm-player" +
              (p.userId === myId() ? " gm-player-me" : "") +
              (p.drawing || (g.turnUserId && g.turnUserId === p.userId)
                ? " gm-player-active"
                : "") +
              (p.got ? " gm-player-got" : ""),
          });
          if (p.drawing)
            row.appendChild(el("span", { class: "gm-badge", title: "Drawing", text: "✎" }));
          else if (p.mark)
            row.appendChild(
              el("span", { class: "gm-badge gm-mark-" + p.mark, text: p.mark }),
            );
          const pfp = avatarNode(seat && seat.avatar);
          if (pfp) row.appendChild(pfp);
          row.appendChild(el("span", { class: "gm-player-name", text: p.username }));
          const badge = badgeFor(seat && seat.role);
          if (badge) row.appendChild(badge);
          const trophy = trophyNode(seat && seat.inviteRank);
          if (trophy) row.appendChild(trophy);
          if (p.got) row.appendChild(el("i", { class: "fas fa-check gm-got" }));
          if (typeof p.score === "number")
            row.appendChild(el("span", { class: "gm-player-score", text: String(p.score) }));
          else if (typeof p.count === "number")
            row.appendChild(
              el("span", { class: "gm-player-score", text: p.count + "w" }),
            );

          // Vote somebody out, only ever offered to the people playing.
          if (t.canVote && seatedPlayer && p.userId !== myId()) {
            const v = (t.votes || []).find((x) => x.userId === p.userId);
            const btn = el("button", {
              class: "gm-kick" + (v && v.mine ? " gm-kick-voted" : ""),
              title: "Vote to remove " + p.username,
              onclick: () =>
                S.emit("games vote remove", {
                  tableId: t.id,
                  targetUserId: p.userId,
                }),
            }, el("i", { class: "fas fa-user-slash" }));
            if (v && v.count)
              btn.appendChild(
                el("span", { class: "gm-kick-n", text: v.count + "/" + t.voteNeeded }),
              );
            row.appendChild(btn);
          }
          playersEl.appendChild(row);
        });

        // Backfill history the first time this game opens.
        if (!lastChatId && Array.isArray(t.chat)) {
          t.chat.forEach((m) => {
            lastChatId = Math.max(lastChatId, m.id);
            addLine(m);
          });
          logEl.scrollTop = logEl.scrollHeight;
        }
        paintTyping(t.typing || []);
      },
    };

    function paintTyping(users) {
      if (!typingEl) return;
      if (!users.length) {
        typingEl.textContent = "";
        return;
      }
      const names = users.map((u) => u.username).filter(Boolean);
      typingEl.textContent = names.length
        ? (names.length === 1
            ? names[0] + " is typing"
            : names.slice(0, 2).join(" and ") + " are typing") + "..."
        : "Someone is typing...";
    }
  }

  // ── Boards ────────────────────────────────────────────────────────────────

  const BOARDS = {};

  // Tic Tac Toe -------------------------------------------------------------
  BOARDS.tictactoe = function () {
    let youAre, gridEl;
    const cells = [];
    return {
      mount(stage) {
        const root = el("div", { class: "gm-board gm-ttt" });
        youAre = el("div", { class: "gm-youare" });
        gridEl = el("div", { class: "gm-ttt-grid" });
        for (let i = 0; i < 9; i++) {
          const c = el("button", {
            class: "gm-ttt-cell",
            onclick: () =>
              S.emit("games move", { tableId: detail.id, move: { cell: i } }),
          });
          cells.push(c);
          gridEl.appendChild(c);
        }
        root.appendChild(youAre);
        root.appendChild(gridEl);
        stage.appendChild(root);
      },
      update(t) {
        const g = t.game;
        youAre.textContent = "";
        if (!g) {
          gridEl.classList.add("gm-idle");
          cells.forEach((c) => {
            c.textContent = "";
            c.disabled = true;
            c.className = "gm-ttt-cell";
          });
          youAre.appendChild(el("span", { text: "Waiting for a player" }));
          return;
        }
        gridEl.classList.remove("gm-idle");
        const me = g.players.find((p) => p.userId === myId());
        if (me) {
          youAre.appendChild(el("span", { text: "You are" }));
          youAre.appendChild(
            el("b", { class: "gm-mark-" + me.mark, text: me.mark }),
          );
        }
        const mine = g.turnUserId === myId() && t.state === "playing";
        gridEl.classList.toggle("gm-myturn", mine);
        for (let i = 0; i < 9; i++) {
          const v = g.board[i];
          cells[i].textContent = v || "";
          cells[i].disabled = !mine || !!v;
          cells[i].className =
            "gm-ttt-cell" +
            (v ? " gm-mark-" + v : "") +
            (g.line && g.line.indexOf(i) >= 0 ? " gm-win" : "") +
            (!v && mine ? " gm-open" : "");
        }
      },
    };
  };

  // Connect Four ------------------------------------------------------------
  BOARDS.connect4 = function () {
    let youAre, gridEl, colBar;
    const cells = [];
    return {
      mount(stage) {
        const root = el("div", { class: "gm-board gm-c4" });
        youAre = el("div", { class: "gm-youare" });
        colBar = el("div", { class: "gm-c4-cols" });
        gridEl = el("div", { class: "gm-c4-grid" });
        for (let c = 0; c < 7; c++) {
          colBar.appendChild(
            el("button", {
              class: "gm-c4-drop",
              "aria-label": "Drop in column " + (c + 1),
              onclick: () =>
                S.emit("games move", { tableId: detail.id, move: { col: c } }),
              onmouseenter: () => hover(c, true),
              onmouseleave: () => hover(c, false),
            }, el("i", { class: "fas fa-caret-down" })),
          );
        }
        for (let i = 0; i < 42; i++) {
          const cell = el("div", { class: "gm-c4-cell" }, el("span"));
          cells.push(cell);
          gridEl.appendChild(cell);
        }
        root.appendChild(youAre);
        root.appendChild(colBar);
        root.appendChild(gridEl);
        stage.appendChild(root);
      },
      update(t) {
        const g = t.game;
        youAre.textContent = "";
        const drops = colBar.querySelectorAll(".gm-c4-drop");
        if (!g) {
          cells.forEach((c) => (c.className = "gm-c4-cell"));
          drops.forEach((d) => (d.disabled = true));
          youAre.appendChild(el("span", { text: "Waiting for a player" }));
          return;
        }
        const me = g.players.find((p) => p.userId === myId());
        if (me) {
          youAre.appendChild(el("span", { text: "You are" }));
          youAre.appendChild(
            el("b", { class: "gm-disc gm-c4-" + me.mark, text: me.mark === "R" ? "red" : "yellow" }),
          );
        }
        const mine = g.turnUserId === myId() && t.state === "playing";
        gridEl.classList.toggle("gm-myturn", mine);
        gridEl.dataset.mark = me ? me.mark : "";
        drops.forEach((d, i) => {
          d.disabled = !mine || g.heights[i] >= g.rows;
        });
        const winSet = {};
        (g.line || []).forEach((p) => {
          winSet[(g.rows - 1 - p.row) * g.cols + p.col] = true;
        });
        for (let i = 0; i < g.grid.length; i++) {
          const v = g.grid[i];
          cells[i].className =
            "gm-c4-cell" + (v ? " gm-c4-" + v : "") + (winSet[i] ? " gm-win" : "");
        }
      },
    };

    function hover(col, on) {
      for (let r = 0; r < 6; r++)
        cells[r * 7 + col].classList.toggle("gm-c4-hover", on);
    }
  };

  // Word Race ---------------------------------------------------------------
  BOARDS.wordrace = function () {
    let gridEl, form, input, feedback, mineEl, scoreEl, barFill, finalEl, timerEl;
    const tiles = [];
    let focused = false;

    return {
      mount(stage) {
        const root = el("div", { class: "gm-board gm-wr" });

        const timerRow = el("div", { class: "gm-wr-timer" });
        timerEl = el("span", { class: "gm-count gm-wr-secs" });
        timerRow.appendChild(timerEl);
        barFill = el("div", { class: "gm-wr-bar-fill" });
        timerRow.appendChild(el("div", { class: "gm-wr-bar" }, barFill));
        root.appendChild(timerRow);

        gridEl = el("div", { class: "gm-wr-grid" });
        for (let i = 0; i < 16; i++) {
          const tile = el("div", { class: "gm-wr-tile" });
          tiles.push(tile);
          gridEl.appendChild(tile);
        }
        root.appendChild(gridEl);

        scoreEl = el("div", { class: "gm-wr-score" });
        root.appendChild(scoreEl);

        input = el("input", {
          class: "gm-wr-input",
          type: "text",
          maxlength: "16",
          placeholder: "type a word and press enter",
          autocomplete: "off",
          autocapitalize: "off",
          spellcheck: "false",
        });
        form = el("form", { class: "gm-wr-form" }, [
          input,
          el("button", { class: "gm-btn gm-btn-primary", type: "submit", text: "Add" }),
        ]);
        form.addEventListener("submit", (e) => {
          e.preventDefault();
          const w = input.value.trim();
          if (!w) return;
          S.emit("games move", { tableId: detail.id, move: { word: w } });
          input.value = "";
        });
        root.appendChild(form);

        feedback = el("div", { class: "gm-wr-feedback" });
        root.appendChild(feedback);
        mineEl = el("div", { class: "gm-wr-mine" });
        root.appendChild(mineEl);
        finalEl = el("div", { class: "gm-wr-final" });
        root.appendChild(finalEl);
        stage.appendChild(root);
      },
      feedbackMsg(msg, good) {
        feedback.textContent = msg;
        feedback.className = "gm-wr-feedback " + (good ? "gm-good" : "gm-bad");
        clearTimeout(feedback._t);
        feedback._t = setTimeout(() => {
          feedback.textContent = "";
          feedback.className = "gm-wr-feedback";
        }, 1600);
      },
      update(t) {
        const g = t.game;
        if (!g) {
          gridEl.classList.add("gm-idle");
          form.style.display = "none";
          return;
        }
        gridEl.classList.remove("gm-idle");
        for (let i = 0; i < 16; i++) tiles[i].textContent = g.grid[i] || "";

        if (!g.over && g.endsAt) {
          barFill.dataset.barEnd = String(g.endsAt);
          barFill.dataset.barSpan = String(g.durationMs);
          timerEl.dataset.deadline = String(g.endsAt);
          barFill.parentNode.parentNode.style.display = "";
        } else {
          delete barFill.dataset.barEnd;
          delete timerEl.dataset.deadline;
          barFill.parentNode.parentNode.style.display = "none";
        }

        scoreEl.textContent = "";
        scoreEl.appendChild(el("span", { class: "gm-wr-pts", text: String(g.myScore || 0) }));
        scoreEl.appendChild(
          el("span", {
            class: "gm-wr-pts-label",
            text: " points from " + g.myWords.length + (g.myWords.length === 1 ? " word" : " words"),
          }),
        );

        const live = !g.over && t.state === "playing" && t.seated;
        form.style.display = live ? "" : "none";
        if (live && !focused) {
          focused = true;
          setTimeout(() => input.focus(), 30);
        }

        mineEl.textContent = "";
        g.myWords
          .slice()
          .reverse()
          .forEach((w) => {
            mineEl.appendChild(
              el("span", { class: "gm-wr-word" }, [
                el("b", { text: w.word }),
                el("i", { text: "+" + w.pts }),
              ]),
            );
          });

        finalEl.textContent = "";
        if (g.over && g.finalScores) {
          finalEl.appendChild(section("fa-trophy", "Final scores"));
          g.finalScores.forEach((s, i) => {
            const row = el("div", {
              class: "gm-wr-rank" + (i === 0 ? " gm-first" : ""),
            });
            row.appendChild(
              el("div", { class: "gm-wr-rank-head" }, [
                el("span", { class: "gm-wr-pos", text: "#" + (i + 1) }),
                el("span", { class: "gm-wr-who", text: s.username }),
                el("span", { class: "gm-wr-total", text: String(s.score) }),
              ]),
            );
            const words = el("div", { class: "gm-wr-list" });
            s.words.forEach((w) => {
              words.appendChild(
                el("span", { class: "gm-wr-word" + (w.dup ? " gm-dup" : "") }, [
                  el("b", { text: w.word }),
                  el("i", { text: w.dup ? "both found it" : "+" + w.pts }),
                ]),
              );
            });
            row.appendChild(words);
            finalEl.appendChild(row);
          });
          finalEl.appendChild(
            el("div", {
              class: "gm-wr-possible",
              text: "There were " + g.possible + " words hiding in that grid.",
            }),
          );
        }
      },
    };
  };

  // Draw & Guess ------------------------------------------------------------
  BOARDS.drawguess = function () {
    let promptEl, choiceEl, canvas, ctx, tools, guessForm, guessInput, gotEl, progEl;
    let drawing = false;
    let last = null;
    let pending = [];
    let flushTimer = null;
    let color = 0;
    let brush = 1;
    let strokes = [];
    let painted = 0;
    let startNext = true;
    // Revision the server stamps on each canvas change. Local strokes are drawn
    // optimistically and counted here too, so a state push arriving while a
    // batch is still in flight cannot roll the canvas back.
    let rev = -1;
    let syncing = false;

    function clearCanvas() {
      ctx.fillStyle = "#fdf5e6";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    function drawSeg(s) {
      ctx.strokeStyle = DRAW_COLORS[s.c] || DRAW_COLORS[0];
      ctx.lineWidth = Math.max(1, (s.w || 3) * (canvas.width / 700));
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(s.x0 * canvas.width, s.y0 * canvas.height);
      ctx.lineTo(s.x1 * canvas.width, s.y1 * canvas.height);
      ctx.stroke();
    }
    function repaint() {
      clearCanvas();
      strokes.forEach(drawSeg);
      painted = strokes.length;
    }
    function resize() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      repaint();
    }
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return {
        x: Math.max(0, Math.min(1, (p.clientX - r.left) / r.width)),
        y: Math.max(0, Math.min(1, (p.clientY - r.top) / r.height)),
      };
    }
    function canDraw() {
      return !!(detail && detail.game && detail.game.amDrawer && detail.game.phase === "drawing");
    }
    function flush() {
      flushTimer = null;
      if (!pending.length) return;
      S.emit("games draw", { tableId: detail.id, segments: pending.splice(0, 40) });
      if (pending.length) flushTimer = setTimeout(flush, 50);
    }
    function push(seg) {
      strokes.push(seg);
      drawSeg(seg);
      painted = strokes.length;
      pending.push(seg);
      if (!flushTimer) flushTimer = setTimeout(flush, 50);
    }
    function down(e) {
      if (!canDraw()) return;
      e.preventDefault();
      drawing = true;
      startNext = true;
      last = pos(e);
    }
    function move(e) {
      if (!drawing || !canDraw()) return;
      e.preventDefault();
      const p = pos(e);
      // Skip micro jitter; fewer segments means a smaller replay for joiners.
      if (Math.abs(p.x - last.x) < 0.002 && Math.abs(p.y - last.y) < 0.002) return;
      const seg = { x0: last.x, y0: last.y, x1: p.x, y1: p.y, c: color, w: BRUSHES[brush] };
      if (startNext) {
        seg.start = 1;
        startNext = false;
      }
      push(seg);
      last = p;
    }
    function up() {
      drawing = false;
      last = null;
    }

    return {
      mount(stage) {
        const root = el("div", { class: "gm-board gm-dg" });

        progEl = el("div", { class: "gm-dg-progress" });
        root.appendChild(progEl);

        promptEl = el("div", { class: "gm-dg-prompt" });
        root.appendChild(promptEl);
        choiceEl = el("div", { class: "gm-dg-choices" });
        root.appendChild(choiceEl);

        canvas = el("canvas", { class: "gm-dg-canvas" });
        root.appendChild(el("div", { class: "gm-dg-canvas-wrap" }, canvas));
        ctx = canvas.getContext("2d");
        clearCanvas();

        canvas.addEventListener("mousedown", down);
        canvas.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
        canvas.addEventListener("touchstart", down, { passive: false });
        canvas.addEventListener("touchmove", move, { passive: false });
        window.addEventListener("touchend", up);

        tools = el("div", { class: "gm-dg-tools" });
        const swatches = el("div", { class: "gm-dg-swatches" });
        DRAW_COLORS.forEach((c, i) => {
          const b = el("button", {
            class: "gm-dg-swatch" + (i === 0 ? " active" : ""),
            "aria-label": "Colour " + (i + 1),
            onclick: () => {
              color = i;
              swatches.querySelectorAll(".gm-dg-swatch").forEach((n, j) =>
                n.classList.toggle("active", j === i),
              );
            },
          });
          b.style.background = c;
          swatches.appendChild(b);
        });
        const sizes = el("div", { class: "gm-dg-sizes" });
        BRUSHES.forEach((w, i) => {
          const b = el("button", {
            class: "gm-dg-size" + (i === brush ? " active" : ""),
            "aria-label": "Brush " + (i + 1),
            onclick: () => {
              brush = i;
              sizes.querySelectorAll(".gm-dg-size").forEach((n, j) =>
                n.classList.toggle("active", j === i),
              );
            },
          });
          const dot = el("span");
          dot.style.width = dot.style.height = Math.min(18, w + 4) + "px";
          b.appendChild(dot);
          sizes.appendChild(b);
        });
        tools.appendChild(swatches);
        tools.appendChild(sizes);
        tools.appendChild(
          el("button", {
            class: "gm-btn gm-btn-ghost",
            onclick: () => S.emit("games draw", { tableId: detail.id, kind: "undo" }),
          }, [el("i", { class: "fas fa-rotate-left" }), " Undo"]),
        );
        tools.appendChild(
          el("button", {
            class: "gm-btn gm-btn-ghost",
            onclick: () => S.emit("games draw", { tableId: detail.id, kind: "clear" }),
          }, [el("i", { class: "fas fa-eraser" }), " Clear"]),
        );
        root.appendChild(tools);

        guessInput = el("input", {
          class: "gm-dg-input",
          type: "text",
          maxlength: "40",
          placeholder: "what is it?",
          autocomplete: "off",
        });
        guessForm = el("form", { class: "gm-dg-guess" }, [
          guessInput,
          el("button", { class: "gm-btn gm-btn-primary", type: "submit", text: "Guess" }),
        ]);
        guessForm.addEventListener("submit", (e) => {
          e.preventDefault();
          const v = guessInput.value.trim();
          if (!v) return;
          S.emit("games move", {
            tableId: detail.id,
            move: { kind: "guess", text: v },
          });
          guessInput.value = "";
        });
        root.appendChild(guessForm);

        gotEl = el("div", { class: "gm-dg-got" });
        root.appendChild(gotEl);

        stage.appendChild(root);
        setTimeout(resize, 0);
        window.addEventListener("resize", resize);
      },
      destroy() {
        window.removeEventListener("resize", resize);
        window.removeEventListener("mouseup", up);
        window.removeEventListener("touchend", up);
        if (flushTimer) clearTimeout(flushTimer);
      },
      relay(payload) {
        if (payload.kind === "strokeBatch") {
          // Our own segments are already on screen; just move the revision on.
          if (detail && detail.game && detail.game.amDrawer) {
            rev = payload.rev;
            return;
          }
          const segs = payload.strokes || [];
          for (const seg of segs) {
            strokes.push(seg);
            drawSeg(seg);
          }
          painted = strokes.length;
          rev = payload.rev;
        } else if (payload.kind === "stroke") {
          if (detail && detail.game && detail.game.amDrawer) {
            rev = payload.rev;
            return;
          }
          strokes.push(payload.stroke);
          drawSeg(payload.stroke);
          painted = strokes.length;
          rev = payload.rev;
        } else if (payload.kind === "clear") {
          strokes = [];
          rev = payload.rev;
          repaint();
        } else if (payload.kind === "strokes") {
          // A full canvas: the answer to a sync, or an undo.
          strokes = payload.strokes || [];
          rev = payload.rev;
          syncing = false;
          repaint();
        }
      },
      say(msg, good) {
        const line = el("div", {
          class: "gm-dg-flash " + (good ? "gm-good" : "gm-bad"),
          text: msg,
        });
        gotEl.insertBefore(line, gotEl.firstChild);
        setTimeout(() => line.remove(), 2600);
      },
      update(t) {
        const g = t.game;
        if (!g) {
          promptEl.textContent = "Getting things ready...";
          choiceEl.textContent = "";
          tools.style.display = "none";
          guessForm.style.display = "none";
          return;
        }
        resize();

        // Never rebuild the canvas from a state push. Ask for a fresh copy
        // only when the revision says we actually missed something and we have
        // nothing of our own still in flight.
        if (rev === -1 || (g.rev > rev && !pending.length && !drawing)) {
          if (!syncing) {
            syncing = true;
            S.emit("games draw", { tableId: detail.id, kind: "sync" });
            setTimeout(() => { syncing = false; }, 1500);
          }
        }

        progEl.textContent = "";
        // No turn count while it is still one person waiting for company.
        if (g.totalTurns && g.phase !== "waiting") {
          progEl.appendChild(
            el("span", { text: "Turn " + Math.min(g.turn + 1, g.totalTurns) + " of " + g.totalTurns }),
          );
          const bar = el("div", { class: "gm-dg-progbar" });
          const fill = el("div", { class: "gm-dg-progfill" });
          fill.style.width = Math.round((g.turn / g.totalTurns) * 100) + "%";
          bar.appendChild(fill);
          progEl.appendChild(bar);
        }

        // A new turn wipes the canvas straight away rather than leaving the
        // last drawing up until the sync comes back.
        if (
          (g.phase === "choosing" || g.phase === "waiting") &&
          strokes.length &&
          !g.strokeCount
        ) {
          strokes = [];
          repaint();
        }

        promptEl.textContent = "";
        choiceEl.textContent = "";

        if (g.phase === "waiting") {
          promptEl.appendChild(
            el("span", { class: "gm-dg-waiting" }, [
              el("i", { class: "fas fa-user-plus" }),
              " Waiting for one more person. Anyone in the room can join.",
            ]),
          );
        } else if (g.phase === "choosing") {
          if (g.amDrawer && g.choices) {
            promptEl.appendChild(el("span", { class: "gm-dg-yourturn", text: "Your turn to draw, pick a word" }));
            g.choices.forEach((w, i) => {
              choiceEl.appendChild(
                el("button", {
                  class: "gm-btn gm-btn-primary gm-dg-choice",
                  text: w,
                  onclick: () =>
                    S.emit("games move", {
                      tableId: detail.id,
                      move: { kind: "pick", index: i },
                    }),
                }),
              );
            });
          } else {
            promptEl.appendChild(
              el("span", { text: (g.drawerName || "Someone") + " is picking a word" }),
            );
          }
          if (g.endsAt)
            promptEl.appendChild(
              el("span", { class: "gm-count gm-count-pill", "data-deadline": String(g.endsAt) }),
            );
        } else if (g.phase === "drawing") {
          if (g.amDrawer) {
            promptEl.appendChild(el("span", { class: "gm-dg-label", text: "You are drawing" }));
            promptEl.appendChild(el("span", { class: "gm-dg-word", text: g.word || "" }));
          } else {
            promptEl.appendChild(
              el("span", { class: "gm-dg-label", text: (g.drawerName || "Someone") + " is drawing" }),
            );
            promptEl.appendChild(el("span", { class: "gm-dg-hint", text: g.hint || "" }));
          }
          if (g.endsAt)
            promptEl.appendChild(
              el("span", { class: "gm-count gm-count-pill", "data-deadline": String(g.endsAt) }),
            );
        } else if (g.phase === "reveal") {
          promptEl.appendChild(el("span", { class: "gm-dg-label", text: "It was" }));
          promptEl.appendChild(el("span", { class: "gm-dg-word", text: g.reveal || "" }));
          const n = g.guessed.length;
          promptEl.appendChild(
            el("span", {
              class: "gm-dg-label",
              text: n ? n + (n === 1 ? " person got it" : " people got it") : "Nobody got it",
            }),
          );
        }

        const iDraw = g.amDrawer && g.phase === "drawing";
        tools.style.display = iDraw ? "" : "none";
        canvas.classList.toggle("gm-dg-live", iDraw);
        guessForm.style.display = t.seated && g.canGuess ? "" : "none";

        // Who has already got it, in order, so the room can see people landing it.
        gotEl.textContent = "";
        if (g.phase === "drawing" && g.guessed.length) {
          g.guessed.forEach((x) => {
            gotEl.appendChild(
              el("span", { class: "gm-dg-gotchip" }, [
                el("i", { class: "fas fa-check" }),
                x.username,
              ]),
            );
          });
        }
        if (g.iGuessed && g.phase === "drawing")
          gotEl.appendChild(
            el("span", { class: "gm-dg-waitline", text: "You got it. Sit tight while the others try." }),
          );
      },
    };
  };

  // ── Socket wiring ─────────────────────────────────────────────────────────

  function takeFloor(d) {
    floor = {
      tables: d.tables || [],
      counts: d.counts || {},
      pools: d.pools || {},
      myQueue: d.myQueue || {},
      myTables: d.myTables || {},
    };
  }

  S.on("games snapshot", (d) => {
    catalog = d.catalog || [];
    takeFloor(d);
    render();
  });

  S.on("games floor", (d) => {
    takeFloor(d);
    if (!isOpen) return;
    if (view.name === "game" && !floor.tables.some((t) => t.id === view.tableId)) {
      view = { name: "floor", tableId: null };
      detail = null;
    }
    render();
  });

  S.on("games table", (d) => {
    if (!d || !d.id) return;
    if (isOpen && view.name !== "game" && d.seated)
      view = { name: "game", tableId: d.id };
    if (view.tableId !== d.id) return;
    detail = d;
    render();
  });

  S.on("games relay", (d) => {
    if (!detail || d.tableId !== detail.id) return;
    if (side && side.relay) side.relay(d);
    if (board && board.relay) board.relay(d);
  });

  S.on("games feedback", (d) => {
    if (!board) return;
    if (d.accepted && board.feedbackMsg)
      board.feedbackMsg(d.accepted + "  +" + d.pts, true);
    else if (d.correct && board.say)
      board.say("Correct, +" + d.pts + " points", true);
    else if (d.close && board.say) board.say("So close", false);
    else if (d.correct === false && board.say) board.say("Not it", false);
  });

  S.on("games error", (d) => {
    const msg = (d && d.message) || "That did not work.";
    if (board && board.feedbackMsg && detail && detail.type === "wordrace")
      board.feedbackMsg(msg, false);
    else toast(msg, "error");
  });

  S.on("games timeout", (d) =>
    toast(
      "Your move ran out of time, so one was played for you." +
        (d && d.warning === 1 ? " Miss another and you lose the seat." : ""),
      "info",
    ),
  );

  S.on("games seat lost", (d) => {
    toast(
      (d.winnerName ? d.winnerName + " kept the board. " : "") +
        "Join " + nameOf(d.type) + " again to get back in.",
      "info",
    );
    if (isOpen && view.tableId === d.tableId) {
      view = { name: "floor", tableId: null };
      detail = null;
      render();
    }
  });

  S.on("games closed", (d) => {
    if (d.reason === "voted-out")
      toast("The other players voted you out of that game.", "error");
    else if (d.reason === "idle")
      toast("You missed two moves in a row, so the seat went to somebody waiting.", "info");
    if (isOpen && view.tableId === d.tableId) {
      view = { name: "floor", tableId: null };
      detail = null;
      render();
    }
  });

  S.on("games challenge", (d) => {
    const body = d.from + " wants to play " + d.gameName + " with you.";
    const answer = (yes) => {
      S.emit("games challenge respond", { id: d.id, accept: !!yes });
      if (yes) openPanel();
    };
    if (window.StaffUI && window.StaffUI.confirm) {
      window.StaffUI.confirm({
        title: "Game invite",
        message: body,
        icon: '<i class="fas fa-gamepad"></i>',
        confirmText: "Let's play",
        cancelText: "Not now",
      }).then(answer);
    } else answer(window.confirm(body));
  });

  S.on("games challenge result", (d) => {
    if (d.accepted) toast((d.by || "They") + " accepted, the game is starting.", "success");
    else if (d.expired) toast("Your invite expired.", "info");
    else toast((d.by || "They") + " passed this time.", "info");
  });

  S.on("room update", (d) => {
    if (d && Array.isArray(d.users)) roomUsers = d.users;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) closePanel();
  });

  window.TalkomaticGames = {
    open: openPanel,
    close: closePanel,
    isOpen: () => isOpen,
  };
})();
