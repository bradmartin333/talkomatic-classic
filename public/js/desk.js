// public/js/desk.js
// The Desk - staff chat and shift console, mounted on every page. The page's
// own script calls TalkoDesk.init(socket); the Desk then asks the server
// "desk hello" and only builds any interface at all if the server answers,
// so a normal user's page never shows a trace of it.
//
// Layout is the familiar messenger shape: channels down the left, the
// conversation in the middle, who-is-on down the right. On a phone the rails
// become drawers and the panel takes the whole screen.
//
// Everything user-authored is rendered with textContent. No innerHTML ever
// touches message text, names, room names, or notes.

(function () {
  "use strict";
  if (window.TalkoDesk) return;

  // ── State ─────────────────────────────────────────────────────────────────
  let socket = null;
  let me = null; // { label, role, level, alias }
  let channels = []; // [{key, name, desc, restricted}]
  let threads = []; // thread summaries
  let unread = {}; // key -> { n, mentions }
  let presence = { staff: [], rooms: [] };
  let view = { kind: "channel", key: "floor" }; // or kind:"thread"
  let mode = "chat"; // chat | inspector | search
  let inspectorRoom = null;
  let searchHits = null;
  let panelOpen = false;
  let mounted = false;
  let showArchived = false;
  let soundOn = localStorage.getItem("talkomatic_deskSound") === "1";
  let audioCtx = null;
  let readTimer = null;
  // /desk.html: the Desk owns the whole window - no pill, no close button.
  let pageMode = false;
  const drafts = new Map(); // key -> composer text not yet sent
  const caches = new Map(); // key -> { messages, hasMore, loaded, detached, newWhile }

  const els = {}; // pill, badge, panel, rail, main, side, list, composer...

  // ── Tiny DOM helpers ──────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(fa) {
    const i = document.createElement("i");
    i.className = "fas " + fa;
    i.setAttribute("aria-hidden", "true");
    return i;
  }
  function btn(cls, label, fa, title) {
    const b = el("button", cls);
    b.type = "button";
    if (fa) b.appendChild(icon(fa));
    if (label) b.appendChild(document.createTextNode(label));
    if (title) b.title = title;
    return b;
  }
  function relTime(ts) {
    if (!ts) return "";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h";
    return Math.floor(h / 24) + "d";
  }
  function clockTime(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (_) {
      return "";
    }
  }
  function dayKey(ts) {
    const d = new Date(ts || 0);
    return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate();
  }
  function dayLabel(ts) {
    const today = new Date();
    if (dayKey(ts) === dayKey(today.getTime())) return "Today";
    if (dayKey(ts) === dayKey(today.getTime() - 86400000)) return "Yesterday";
    try {
      return new Date(ts).toLocaleDateString(undefined, {
        weekday: "long",
        day: "numeric",
        month: "long",
      });
    } catch (_) {
      return new Date(ts).toDateString();
    }
  }

  const rankOf = (a) =>
    !a ? null : a.role === "dev" ? "dev" : (a.level || 2) >= 2 ? "l2" : "l1";
  const rankName = (r) => (r === "dev" ? "DEV" : r === "l2" ? "MOD L2" : "MOD L1");

  // ── Sounds and toasts ─────────────────────────────────────────────────────
  // The beep only ever fires after the user has interacted with the Desk, so
  // it can never hit an autoplay block or surprise a fresh page.
  function beep() {
    if (!soundOn) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.frequency.value = 740;
      g.gain.setValueAtTime(0.06, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.18);
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.2);
    } catch (_) { }
  }

  // One question, one answer. Uses the themed StaffUI prompt when the page
  // has it (all three pages do) and falls back to the native one otherwise,
  // so the Desk never depends on another script being healthy.
  function ask(opts, cb) {
    if (window.StaffUI && window.StaffUI.prompt) {
      window.StaffUI
        .prompt({
          title: opts.title,
          icon: opts.icon || '<i class="fas fa-comments"></i>',
          message: opts.message || "",
          fields: [
            {
              name: "v",
              label: opts.label || "",
              placeholder: opts.placeholder || "",
              value: opts.value || "",
              maxLength: opts.max || 200,
            },
          ],
        })
        .then((r) => {
          if (r && typeof r.v === "string") cb(r.v);
        });
    } else {
      const v = window.prompt(opts.title, opts.value || "");
      if (v != null) cb(v);
    }
  }

  let toastTimer = null;
  function toast(text) {
    if (!els.toast) return;
    els.toast.textContent = text;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
  }

  // ── Cache ─────────────────────────────────────────────────────────────────
  function cacheFor(key) {
    if (!caches.has(key))
      caches.set(key, {
        messages: [],
        hasMore: false,
        loaded: false,
        // A search jump shows an old window of the conversation. While it is
        // up, live messages are counted instead of appended, so the reader is
        // never teleported and the window never grows gaps.
        detached: false,
        newWhile: 0,
      });
    return caches.get(key);
  }
  function upsert(key, msg) {
    const c = cacheFor(key);
    const i = c.messages.findIndex((m) => m.id === msg.id);
    if (i !== -1) {
      c.messages[i] = msg;
      return "updated";
    }
    c.messages.push(msg);
    if (c.messages.length > 400) c.messages.shift();
    return "appended";
  }

  const viewKey = () => view.key;
  const viewingNow = (key) =>
    panelOpen &&
    mode === "chat" &&
    viewKey() === key &&
    !cacheFor(key).detached &&
    document.hasFocus();

  // ── Unread and badges ─────────────────────────────────────────────────────
  function bumpUnread(key, mention) {
    const u = unread[key] || { n: 0, mentions: 0 };
    u.n++;
    if (mention) u.mentions++;
    unread[key] = u;
  }
  function markRead(key) {
    const c = cacheFor(key);
    const last = c.messages[c.messages.length - 1];
    unread[key] = { n: 0, mentions: 0 };
    renderBadges();
    clearTimeout(readTimer);
    readTimer = setTimeout(() => {
      if (socket) socket.emit("desk read", { key, ts: last ? last.ts : Date.now() });
    }, 400);
  }
  function totals() {
    let n = 0;
    let loud = 0;
    for (const k in unread) {
      n += unread[k].n || 0;
      loud += unread[k].mentions || 0;
    }
    // An unclaimed call for backup keeps the badge red until somebody takes it.
    const helpMsgs = cacheFor("help").messages;
    for (const m of helpMsgs)
      if (m.ping && (m.ping.status === "open" || m.ping.status === "waiting"))
        loud++;
    return { n, loud };
  }
  function renderBadges() {
    const t = totals();
    if (els.badge) {
      els.badge.textContent = t.n > 99 ? "99+" : String(t.n);
      els.badge.style.display = t.n ? "" : "none";
      els.badge.classList.toggle("loud", t.loud > 0);
    }
    // The lobby parks its Dev Panel button in the same corner, and it can be
    // created after the pill (it waits for the sign-in round trip). Re-check
    // on every badge pass so the two never end up stacked on each other.
    if (els.pill)
      els.pill.classList.toggle(
        "raised",
        !!document.getElementById("devPanelButton"),
      );
    // The pop-out window has no pill, so the unread count lives in its title.
    if (pageMode)
      document.title = (t.n ? "(" + (t.n > 99 ? "99+" : t.n) + ") " : "") + "The Desk - Talkomatic";
    if (els.rail) renderRail();
  }

  // ── Socket wiring ─────────────────────────────────────────────────────────
  function init(sock) {
    if (!sock || socket) return;
    socket = sock;

    socket.on("desk ready", (d) => {
      if (!d || !d.me) return;
      me = d.me;
      channels = d.channels || [];
      threads = d.threads || [];
      unread = d.unread || {};
      presence = d.presence || presence;
      if (!channels.some((c) => c.key === viewKey()) && view.kind === "channel")
        view = { kind: "channel", key: channels[0] ? channels[0].key : "floor" };
      mount();
      renderBadges();
      if (pageMode && !panelOpen) setOpen(true);
      else if (panelOpen) {
        renderAll();
        loadView(true);
        // A reconnect can land while the inspector is up; its snapshot is
        // stale by definition, so ask for the room again.
        if (mode === "inspector" && inspectorRoom)
          socket.emit("desk room info", { roomId: inspectorRoom.roomId });
      }
    });

    socket.on("desk message", (d) => {
      if (!d || !d.msg) return;
      const c = cacheFor(d.key);
      let change;
      if (c.detached && !d.updated) {
        // Reading an old window: count it instead of appending, and let the
        // "back to the latest" button carry the number.
        c.newWhile++;
        change = "held";
      } else {
        change = upsert(d.key, d.msg);
      }
      const mention =
        d.msg.mention ||
        (me && d.msg.text &&
          d.msg.text.toLowerCase().includes("@" + me.label.toLowerCase()));
      if (change !== "updated" && !viewingNow(d.key)) {
        bumpUnread(d.key, !!mention);
        if (d.msg.kind === "ping" || mention) {
          beep();
          if (els.pill) {
            els.pill.classList.remove("nudge");
            void els.pill.offsetWidth; // restart the animation
            els.pill.classList.add("nudge");
          }
        }
      }
      if (panelOpen && mode === "chat" && viewKey() === d.key) {
        if (change === "appended") appendRow(d.msg);
        else if (change === "updated") updateRow(d.msg);
        else if (change === "held" && els.newer)
          els.newer.lastChild.textContent =
            " Back to the latest (" + c.newWhile + " new)";
        if (viewingNow(d.key)) markRead(d.key);
      }
      renderBadges();
    });

    socket.on("desk unread", (d) => {
      if (d && d.unread) {
        unread = d.unread;
        renderBadges();
      }
    });

    socket.on("desk threads", (d) => {
      threads = (d && d.threads) || [];
      if (
        view.kind === "thread" &&
        !threads.some((t) => t.id === view.key)
      ) {
        view = { kind: "channel", key: "floor" }; // it was deleted under us
        if (panelOpen) loadView(true);
      }
      if (els.rail) renderRail();
    });

    socket.on("desk thread created", (d) => {
      if (d && d.id) openView({ kind: "thread", key: d.id });
    });

    socket.on("desk history", (d) => {
      if (!d || !d.key) return;
      const c = cacheFor(d.key);
      if (d.around != null) {
        // A window centred on a search hit.
        c.messages = d.messages || [];
        c.loaded = true;
        c.detached = !!d.hasMoreNewer;
        c.newWhile = 0;
      } else if (d.before == null) {
        c.messages = d.messages || [];
        c.loaded = true;
        c.detached = false;
        c.newWhile = 0;
      } else {
        const known = new Set(c.messages.map((m) => m.id));
        c.messages = (d.messages || [])
          .filter((m) => !known.has(m.id))
          .concat(c.messages);
      }
      c.hasMore = !!d.hasMore;
      if (panelOpen && mode === "chat" && viewKey() === d.key) {
        renderMessages(d.before != null);
        if (d.around != null) flashNear(d.around);
      }
      if (viewingNow(d.key)) markRead(d.key);
    });

    socket.on("desk presence", (p) => {
      if (p) {
        presence = p;
        if (panelOpen) renderSide();
      }
    });

    socket.on("desk room info", (d) => {
      if (!d) return;
      inspectorRoom = d;
      if (panelOpen && mode === "inspector") renderInspector();
    });

    socket.on("desk search", (d) => {
      if (!d) return;
      searchHits = d.hits || [];
      if (panelOpen && mode === "search") renderSearch();
    });

    socket.on("desk error", (d) => toast((d && d.message) || "That did not work."));

    socket.on("desk ping update", (d) => {
      if (d && d.status === "claimed") toast(d.by + " is on it - they saw your ping.");
    });

    socket.on("staff action result", (d) => {
      if (!d || !panelOpen) return;
      if (d.ok) toast(d.action + " done.");
      // The room may have changed under the inspector; ask again.
      if (mode === "inspector" && inspectorRoom)
        socket.emit("desk room info", { roomId: inspectorRoom.roomId });
    });

    // A failed action must never fail silently. The inspector can be looking
    // at a snapshot ("kick" on somebody who just left), so say what the
    // server said and fetch a fresh view of the room.
    socket.on("error", (d) => {
      if (!panelOpen || mode !== "inspector") return;
      const m = d && d.error && d.error.message;
      if (m) toast(m);
      if (inspectorRoom)
        socket.emit("desk room info", { roomId: inspectorRoom.roomId });
    });

    // A revoked key must lose the Desk instantly, not at next reload.
    socket.on("staff revoked", () => teardown());

    socket.on("connect", () => socket.emit("desk hello"));
    socket.on("disconnect", () => {
      if (els.panel) els.panel.classList.add("dk-offline");
    });
    socket.io?.on?.("reconnect", () => {
      if (els.panel) els.panel.classList.remove("dk-offline");
    });
    socket.on("desk ready", () => {
      if (els.panel) els.panel.classList.remove("dk-offline");
    });

    if (socket.connected) socket.emit("desk hello");
  }

  function teardown() {
    panelOpen = false;
    if (els.panel) els.panel.remove();
    if (els.pill) els.pill.remove();
    mounted = false;
    me = null;
  }

  // ── Mounting ──────────────────────────────────────────────────────────────
  function mount() {
    if (mounted) return;
    if (!document.body) {
      document.addEventListener("DOMContentLoaded", mount, { once: true });
      return;
    }
    mounted = true;
    injectCss();
    if (pageMode) {
      // Its own window: the Desk IS the page. The sign-in gate goes away the
      // moment the server has confirmed a staff key.
      const gate = document.getElementById("deskGate");
      if (gate) gate.remove();
    } else {
      buildPill();
    }
    buildPanel();
    if (pageMode) els.panel.classList.add("dk-fullpage");
  }

  function buildPill() {
    const pill = el("button", "dk-pill");
    pill.type = "button";
    pill.id = "deskPill";
    pill.setAttribute("aria-label", "Open the staff Desk");
    pill.appendChild(icon("fa-comments"));
    pill.appendChild(document.createTextNode(" Desk"));
    const badge = el("span", "dk-pill-badge");
    badge.style.display = "none";
    pill.appendChild(badge);
    // The lobby already parks a Dev Panel button in this corner; stack above it.
    if (document.getElementById("devPanelButton")) pill.classList.add("raised");
    pill.addEventListener("click", toggle);
    document.body.appendChild(pill);
    els.pill = pill;
    els.badge = badge;
    // Quiet pages get no message traffic to trigger a badge pass, so re-check
    // the corner a couple of times while the page finishes signing in.
    setTimeout(renderBadges, 2500);
    setTimeout(renderBadges, 8000);
  }

  function buildPanel() {
    const panel = el("div", "dk-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "The Desk - staff chat");
    panel.style.display = "none";

    // ── Header ──
    const head = el("div", "dk-head");
    const burger = btn("dk-hbtn dk-burger", null, "fa-bars", "Channels");
    burger.addEventListener("click", () => panel.classList.toggle("rail-open"));
    head.appendChild(burger);
    const title = el("div", "dk-title");
    title.appendChild(el("span", "dk-title-main", "The Desk"));
    els.headSub = el("span", "dk-title-sub", "#floor");
    title.appendChild(els.headSub);
    head.appendChild(title);

    const search = el("input", "dk-search");
    search.type = "search";
    search.placeholder = "Search everything you can read";
    search.setAttribute("aria-label", "Search staff chat");
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && search.value.trim().length >= 2) {
        searchHits = null;
        mode = "search";
        socket.emit("desk search", { q: search.value.trim() });
        renderMain();
      }
    });
    head.appendChild(search);
    els.searchInput = search;

    const searchBtn = btn("dk-hbtn dk-msearch", null, "fa-magnifying-glass", "Search");
    searchBtn.addEventListener("click", () =>
      ask(
        { title: "Search staff chat", label: "Looking for", max: 80, icon: '<i class="fas fa-magnifying-glass"></i>' },
        (q) => {
          if (q.trim().length < 2) return;
          searchHits = null;
          mode = "search";
          socket.emit("desk search", { q: q.trim() });
          renderMain();
        },
      ),
    );
    head.appendChild(searchBtn);

    const people = btn("dk-hbtn dk-people", null, "fa-user-group", "Who is on");
    people.addEventListener("click", () => panel.classList.toggle("side-open"));
    head.appendChild(people);

    const sound = btn("dk-hbtn", null, soundOn ? "fa-bell" : "fa-bell-slash", "Sound on new pings and mentions");
    sound.addEventListener("click", () => {
      soundOn = !soundOn;
      localStorage.setItem("talkomatic_deskSound", soundOn ? "1" : "0");
      sound.replaceChild(icon(soundOn ? "fa-bell" : "fa-bell-slash"), sound.firstChild);
      if (soundOn) beep();
    });
    head.appendChild(sound);

    if (!pageMode) {
      // Tear the Desk off into its own window, for a second monitor or just
      // to keep it up while moving between pages.
      const pop = btn("dk-hbtn dk-popbtn", null, "fa-up-right-from-square", "Open in its own window");
      pop.addEventListener("click", () => {
        window.open("/desk.html", "talkodesk", "width=1120,height=780");
        setOpen(false);
      });
      head.appendChild(pop);

      const close = btn("dk-hbtn", null, "fa-xmark", "Close");
      close.addEventListener("click", () => setOpen(false));
      head.appendChild(close);
    }
    panel.appendChild(head);

    // ── Body: rail / main / side ──
    const body = el("div", "dk-body");
    els.rail = el("nav", "dk-rail");
    els.rail.setAttribute("aria-label", "Channels and threads");
    body.appendChild(els.rail);

    els.main = el("div", "dk-main");
    body.appendChild(els.main);

    els.side = el("aside", "dk-side");
    els.side.setAttribute("aria-label", "Who is on");
    body.appendChild(els.side);

    // Tapping the dimmed area closes whichever drawer is open (mobile).
    const scrim = el("div", "dk-scrim");
    scrim.addEventListener("click", () =>
      panel.classList.remove("rail-open", "side-open"),
    );
    body.appendChild(scrim);
    panel.appendChild(body);

    els.toast = el("div", "dk-toast");
    panel.appendChild(els.toast);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && panelOpen && !pageMode) setOpen(false);
    });
    window.addEventListener("focus", () => {
      if (viewingNow(viewKey())) markRead(viewKey());
    });

    document.body.appendChild(panel);
    els.panel = panel;
  }

  function setOpen(on) {
    if (pageMode && !on) return; // the window's own close button does this
    panelOpen = !!on;
    if (!els.panel) return;
    els.panel.style.display = panelOpen ? "" : "none";
    els.panel.classList.remove("rail-open", "side-open");
    if (panelOpen) {
      renderAll();
      loadView(true);
      socket.emit("desk presence");
    }
  }
  const toggle = () => setOpen(!panelOpen);

  // ── View switching ────────────────────────────────────────────────────────
  function openView(v) {
    view = v;
    mode = "chat";
    if (els.panel) els.panel.classList.remove("rail-open", "side-open");
    renderAll();
    loadView();
  }
  function loadView(force) {
    const c = cacheFor(viewKey());
    if (!c.loaded || force) socket.emit("desk history", { key: viewKey() });
    else if (viewingNow(viewKey())) markRead(viewKey());
  }

  function renderAll() {
    renderRail();
    renderMain();
    renderSide();
  }

  // ── Rail ──────────────────────────────────────────────────────────────────
  function renderRail() {
    if (!els.rail || !me) return;
    const rail = els.rail;
    rail.textContent = "";

    rail.appendChild(el("div", "dk-rail-h", "Channels"));
    for (const c of channels) {
      const row = el("button", "dk-chan" + (view.kind === "channel" && viewKey() === c.key && mode === "chat" ? " on" : ""));
      row.type = "button";
      row.appendChild(el("span", "dk-hash", "#"));
      row.appendChild(el("span", "dk-chan-name", c.name));
      if (c.restricted) row.appendChild(icon("fa-lock"));
      const u = unread[c.key];
      if (u && u.n) {
        const b = el("span", "dk-b" + (u.mentions ? " loud" : ""), u.n > 99 ? "99+" : String(u.n));
        row.appendChild(b);
      }
      row.title = c.desc || "";
      row.addEventListener("click", () => openView({ kind: "channel", key: c.key }));
      rail.appendChild(row);
    }

    const th = el("div", "dk-rail-h");
    th.appendChild(document.createTextNode("Threads"));
    const add = btn("dk-tadd", null, "fa-plus", "New thread");
    add.addEventListener("click", () =>
      ask(
        {
          title: "New thread",
          label: "What is it about?",
          placeholder: "raid in 67room67",
          max: 60,
          message: "Threads that go quiet for a day drop into the archive but stay readable.",
        },
        (t) => {
          if (t.trim()) socket.emit("desk thread create", { title: t.trim() });
        },
      ),
    );
    th.appendChild(add);
    rail.appendChild(th);

    const live = threads.filter((t) => !t.archived).sort((a, b) => b.lastTs - a.lastTs);
    const archived = threads.filter((t) => t.archived).sort((a, b) => b.lastTs - a.lastTs);
    if (!live.length) rail.appendChild(el("div", "dk-rail-empty", "No open threads."));
    for (const t of live) rail.appendChild(threadRow(t));

    if (archived.length) {
      const tog = el("button", "dk-arch-toggle");
      tog.type = "button";
      tog.appendChild(icon(showArchived ? "fa-chevron-down" : "fa-chevron-right"));
      tog.appendChild(document.createTextNode(" Archived (" + archived.length + ")"));
      tog.addEventListener("click", () => {
        showArchived = !showArchived;
        renderRail();
      });
      rail.appendChild(tog);
      if (showArchived) for (const t of archived) rail.appendChild(threadRow(t, true));
    }

    // Decision made out loud, not buried: moderators know devs can read it all.
    rail.appendChild(
      el("div", "dk-rail-foot", "Developers can read every channel and thread, including edits and deletions."),
    );
  }

  function threadRow(t, archived) {
    const row = el("button", "dk-thread" + (view.kind === "thread" && viewKey() === t.id && mode === "chat" ? " on" : "") + (archived ? " arch" : ""));
    row.type = "button";
    row.appendChild(icon("fa-message"));
    const w = el("span", "dk-thread-t", t.title);
    row.appendChild(w);
    const u = unread[t.id];
    if (u && u.n && !archived) row.appendChild(el("span", "dk-dot"));
    row.title = "Started by " + t.createdBy + (t.link ? " - about " + t.link.roomName : "");
    row.addEventListener("click", () => openView({ kind: "thread", key: t.id }));
    return row;
  }

  // ── Main pane ─────────────────────────────────────────────────────────────
  function renderMain() {
    if (!els.main) return;
    if (mode === "inspector") return renderInspector();
    if (mode === "search") return renderSearch();
    const main = els.main;
    main.textContent = "";

    const ch = channels.find((c) => c.key === viewKey());
    const th = threads.find((t) => t.id === viewKey());
    if (els.headSub)
      els.headSub.textContent = view.kind === "channel" ? "#" + (ch ? ch.name : viewKey()) : th ? th.title : "thread";

    if (view.kind === "thread" && th) {
      const bar = el("div", "dk-threadbar");
      bar.appendChild(el("span", "dk-threadbar-t", th.title));
      bar.appendChild(
        el("span", "dk-threadbar-s",
          (th.archived ? "Archived - a reply reopens it. " : "") +
          "Started by " + th.createdBy),
      );
      if (th.link) {
        const jump = btn("dk-minib", th.link.roomName, "fa-door-open", "Inspect this room");
        jump.addEventListener("click", () => openInspector(th.link.roomId));
        bar.appendChild(jump);
      }
      if (me && me.role === "dev") {
        const del = btn("dk-minib danger", "Delete", "fa-trash", "Hard-delete this thread (dev)");
        armTwice(del, "Delete for good?", () =>
          socket.emit("desk thread delete", { id: th.id }),
        );
        bar.appendChild(del);
      }
      main.appendChild(bar);
    } else if (ch && ch.desc) {
      const bar = el("div", "dk-chandesc", ch.desc);
      main.appendChild(bar);
    }

    els.list = el("div", "dk-msgs");
    els.list.setAttribute("aria-live", "polite");
    main.appendChild(els.list);

    // ── Composer ──
    const comp = el("div", "dk-comp");
    const ta = el("textarea", "dk-input");
    ta.rows = 1;
    ta.maxLength = 1200;
    ta.placeholder =
      view.kind === "channel" ? "Message #" + (ch ? ch.name : "") : "Reply in thread";
    ta.setAttribute("aria-label", ta.placeholder);
    const count = el("span", "dk-count");
    const send = btn("dk-send", null, "fa-paper-plane", "Send");
    const sizeTa = () => {
      ta.style.height = "";
      ta.style.height = Math.min(ta.scrollHeight, 110) + "px";
      count.textContent = ta.value.length > 1000 ? 1200 - ta.value.length + " left" : "";
    };
    const doSend = () => {
      const text = ta.value.trim();
      if (!text) return;
      socket.emit("desk send", { key: viewKey(), text });
      drafts.delete(viewKey());
      ta.value = "";
      sizeTa();
      ta.focus();
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        doSend();
      }
    });
    ta.addEventListener("input", () => {
      // Half-typed messages follow you between channels and page loads within
      // the session, instead of vanishing on every switch.
      if (ta.value) drafts.set(viewKey(), ta.value);
      else drafts.delete(viewKey());
      sizeTa();
    });
    if (drafts.has(viewKey())) {
      ta.value = drafts.get(viewKey());
      requestAnimationFrame(sizeTa);
    }
    send.addEventListener("click", doSend);
    comp.appendChild(ta);
    comp.appendChild(count);
    comp.appendChild(send);
    main.appendChild(comp);
    els.composer = ta;

    renderMessages();
  }

  function nearBottom() {
    const l = els.list;
    return l && l.scrollHeight - l.scrollTop - l.clientHeight < 120;
  }

  function renderMessages(keepScroll) {
    const list = els.list;
    if (!list) return;
    const c = cacheFor(viewKey());
    const prevHeight = list.scrollHeight;
    const prevTop = list.scrollTop;
    list.textContent = "";

    if (c.hasMore) {
      const older = btn("dk-older", "Load older", "fa-chevron-up");
      older.addEventListener("click", () => {
        const first = c.messages[0];
        socket.emit("desk history", { key: viewKey(), before: first ? first.ts : Date.now() });
      });
      list.appendChild(older);
    }

    if (!c.messages.length && c.loaded) {
      list.appendChild(el("div", "dk-empty", "Nothing here yet. Say hello."));
    }

    let prev = null;
    let lastDay = null;
    for (const m of c.messages) {
      const dk = dayKey(m.ts);
      if (dk !== lastDay) {
        lastDay = dk;
        list.appendChild(el("div", "dk-day", dayLabel(m.ts)));
        prev = null;
      }
      list.appendChild(row(m, prev));
      prev = m;
    }

    // Looking at an old window after a search jump: the way home is explicit,
    // and it carries the count of what has happened since.
    els.newer = null;
    if (c.detached) {
      const newer = btn(
        "dk-older dk-newer",
        c.newWhile ? " Back to the latest (" + c.newWhile + " new)" : " Back to the latest",
        "fa-chevron-down",
      );
      newer.addEventListener("click", () =>
        socket.emit("desk history", { key: viewKey() }),
      );
      list.appendChild(newer);
      els.newer = newer;
    }

    if (keepScroll) {
      list.scrollTop = prevTop + (list.scrollHeight - prevHeight);
    } else {
      list.scrollTop = list.scrollHeight;
    }
  }

  // Scroll to the message nearest a timestamp and flash it - the landing half
  // of a search jump.
  function flashNear(ts) {
    const c = cacheFor(viewKey());
    if (!c.messages.length || !els.list) return;
    let best = c.messages[0];
    for (const m of c.messages)
      if (Math.abs(m.ts - ts) < Math.abs(best.ts - ts)) best = m;
    const node = els.list.querySelector('[data-id="' + best.id + '"]');
    if (!node) return;
    node.scrollIntoView({ block: "center" });
    node.classList.add("flash");
    setTimeout(() => node.classList.remove("flash"), 1800);
  }

  function appendRow(msg) {
    const list = els.list;
    if (!list) return renderMessages();
    const c = cacheFor(viewKey());
    const stick = nearBottom();
    const prev = c.messages.length > 1 ? c.messages[c.messages.length - 2] : null;
    if (!prev || dayKey(prev.ts) !== dayKey(msg.ts))
      list.appendChild(el("div", "dk-day", dayLabel(msg.ts)));
    list.appendChild(row(msg, prev));
    if (stick) list.scrollTop = list.scrollHeight;
  }

  function updateRow(msg) {
    const list = els.list;
    if (!list) return;
    const node = list.querySelector('[data-id="' + msg.id + '"]');
    if (!node) return;
    const c = cacheFor(viewKey());
    const i = c.messages.findIndex((m) => m.id === msg.id);
    const prev = i > 0 ? c.messages[i - 1] : null;
    node.replaceWith(row(msg, prev));
  }

  // One message row. `prev` decides whether the author header repeats.
  function row(m, prev) {
    if (m.kind === "ping") return pingCard(m);
    if (m.kind === "system") {
      // Queue cards carry the same icon language the dashboard feed uses,
      // one color per kind, on the icon itself.
      const QICON = {
        report: "fa-flag",
        appeal: "fa-scale-balanced",
        application: "fa-file-signature",
        suggestion: "fa-lightbulb",
        invite: "fa-user-plus",
        abuse: "fa-triangle-exclamation",
      };
      const r = el("div", "dk-sys" + (m.qkind ? " card q-" + m.qkind : ""));
      r.dataset.id = m.id;
      r.appendChild(icon(QICON[m.qkind] || "fa-circle-info"));
      r.appendChild(el("span", "dk-sys-x", m.text));
      r.appendChild(el("span", "dk-sys-t", clockTime(m.ts)));
      return r;
    }

    const grouped =
      prev &&
      prev.kind === "chat" &&
      m.kind === "chat" &&
      prev.author && m.author &&
      prev.author.label === m.author.label &&
      prev.author.role === m.author.role &&
      m.ts - prev.ts < 5 * 60 * 1000 &&
      !prev.deletedAt;

    const mention =
      m.mention ||
      (me && m.text && m.text.toLowerCase().includes("@" + me.label.toLowerCase()));

    const r = el("div", "dk-msg" + (grouped ? " grouped" : "") + (mention ? " mention" : ""));
    r.dataset.id = m.id;

    if (!grouped) {
      const rank = rankOf(m.author);
      const av = el("span", "dk-av " + rank, (m.author.label || "?").charAt(0).toUpperCase());
      r.appendChild(av);
      const head = el("div", "dk-mhead");
      head.appendChild(el("span", "dk-mname", m.author.label));
      head.appendChild(el("span", "dk-chip " + rank, rankName(rank)));
      if (m.author.alias && m.author.alias !== m.author.label)
        head.appendChild(el("span", "dk-alias", 'as "' + m.author.alias + '"'));
      const t = el("span", "dk-mtime", clockTime(m.ts));
      t.title = new Date(m.ts).toLocaleString();
      head.appendChild(t);
      r.appendChild(head);
    }

    const body = el("div", "dk-mbody");
    if (m.deletedAt) {
      body.appendChild(el("span", "dk-tomb", "Message removed by " + (m.deletedBy || "?")));
    } else {
      body.appendChild(el("span", "dk-mtext", m.text));
      if (m.editedAt) {
        const e = el("span", "dk-edited", "(edited)");
        e.title = "Edited " + new Date(m.editedAt).toLocaleString();
        body.appendChild(e);
      }
    }
    // A dev can always read what a message used to say.
    if (me && me.role === "dev" && m.history && m.history.length) {
      const h = el("button", "dk-hist");
      h.type = "button";
      h.textContent = "history (" + m.history.length + ")";
      h.addEventListener("click", () => {
        let open = r.querySelector(".dk-histbox");
        if (open) return open.remove();
        open = el("div", "dk-histbox");
        for (const v of m.history) {
          const line = el("div", "dk-histline");
          line.appendChild(el("span", "dk-hist-t", new Date(v.ts).toLocaleString()));
          line.appendChild(el("span", null, v.text));
          open.appendChild(line);
        }
        r.appendChild(open);
      });
      body.appendChild(h);
    }
    r.appendChild(body);

    // On touch layouts the tool row stays hidden until the message is tapped,
    // so a dev scrolling the floor is not looking at a column of bins.
    r.addEventListener("click", (e) => {
      if (e.target.closest("button, textarea, a, input")) return;
      r.classList.toggle("tools");
    });

    // Own messages get edit and delete; devs get delete on anything.
    const own = me && m.author && m.author.label === me.label && m.author.role === me.role;
    if (!m.deletedAt && (own || (me && me.role === "dev"))) {
      const tools = el("div", "dk-mtools");
      if (own && Date.now() - m.ts < 5 * 60 * 1000) {
        const eb = btn("dk-tool", null, "fa-pen", "Edit");
        eb.addEventListener("click", () => startEdit(r, m));
        tools.appendChild(eb);
      }
      const db = btn("dk-tool", null, "fa-trash", own ? "Delete" : "Delete (dev)");
      armTwice(db, null, () => socket.emit("desk delete", { id: m.id }));
      tools.appendChild(db);
      r.appendChild(tools);
    }
    return r;
  }

  function startEdit(node, m) {
    const body = node.querySelector(".dk-mbody");
    if (!body || body.querySelector("textarea")) return;
    body.textContent = "";
    const ta = el("textarea", "dk-editbox");
    ta.value = m.text;
    ta.maxLength = 1200;
    const save = btn("dk-minib", "Save", "fa-check");
    const cancel = btn("dk-minib", "Cancel", "fa-xmark");
    save.addEventListener("click", () => {
      const t = ta.value.trim();
      if (t && t !== m.text) socket.emit("desk edit", { id: m.id, text: t });
      else updateRow(m);
    });
    cancel.addEventListener("click", () => updateRow(m));
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        save.click();
      }
      if (e.key === "Escape") cancel.click();
    });
    body.appendChild(ta);
    body.appendChild(save);
    body.appendChild(cancel);
    ta.focus();
  }

  // Destructive buttons ask once, inline: first tap arms, second confirms.
  function armTwice(b, label, fn) {
    let armed = false;
    let timer = null;
    b.addEventListener("click", () => {
      if (armed) {
        clearTimeout(timer);
        armed = false;
        b.classList.remove("armed");
        fn();
        return;
      }
      armed = true;
      b.classList.add("armed");
      if (label) b.title = label;
      timer = setTimeout(() => {
        armed = false;
        b.classList.remove("armed");
      }, 2600);
    });
  }

  // ── Ping cards ────────────────────────────────────────────────────────────
  function pingCard(m) {
    const p = m.ping || {};
    const r = el("div", "dk-ping s-" + (p.status || "open"));
    r.dataset.id = m.id;

    const head = el("div", "dk-ping-h");
    head.appendChild(el("span", "dk-ping-badge", (p.status || "open").toUpperCase()));
    head.appendChild(el("span", "dk-ping-t", "@" + (p.wants || "mod") + " needed in " + (p.roomName || "?")));
    const t = el("span", "dk-mtime", relTime(m.ts));
    t.title = new Date(m.ts).toLocaleString();
    head.appendChild(t);
    r.appendChild(head);

    const meta = el("div", "dk-ping-m");
    meta.appendChild(el("span", null, "Asked by " + (p.byLabel || "?") + " - " + (p.count || 0) + " in the room"));
    if (p.staffThere && p.staffThere.length)
      meta.appendChild(el("span", "dk-ping-staff", "Staff there: " + p.staffThere.join(", ")));
    if (p.status === "claimed" && p.claimedBy)
      meta.appendChild(el("span", "dk-ping-claim", p.claimedBy + " is on it"));
    if (p.status === "resolved")
      meta.appendChild(el("span", "dk-ping-done", "Resolved by " + (p.resolvedBy || "?") + (p.note ? ' - "' + p.note + '"' : "")));
    r.appendChild(meta);

    if (p.actions && p.actions.length) {
      const acts = el("div", "dk-ping-acts");
      for (const a of p.actions.slice(-6)) {
        acts.appendChild(
          el("div", "dk-ping-act", a.by + " " + a.action + (a.target ? " on " + a.target : "")),
        );
      }
      r.appendChild(acts);
    }

    const bar = el("div", "dk-ping-b");
    if (p.status === "open" || p.status === "waiting") {
      const claim = btn("dk-minib primary", "Claim", "fa-hand");
      claim.addEventListener("click", () => socket.emit("desk ping claim", { id: m.id }));
      bar.appendChild(claim);
    }
    if (p.status !== "resolved") {
      const res = btn("dk-minib", "Resolve", "fa-check");
      res.addEventListener("click", () =>
        ask(
          { title: "Resolve this ping", label: "What happened? (optional)", max: 200, icon: '<i class="fas fa-check"></i>' },
          (note) => socket.emit("desk ping resolve", { id: m.id, note }),
        ),
      );
      bar.appendChild(res);
    }
    const insp = btn("dk-minib", "Inspect", "fa-eye");
    insp.addEventListener("click", () => openInspector(p.roomId));
    bar.appendChild(insp);
    const join = btn("dk-minib", "Join", "fa-door-open");
    join.addEventListener("click", () => window.open("/room.html?roomId=" + encodeURIComponent(p.roomId), "_blank"));
    bar.appendChild(join);
    const watch = btn("dk-minib", "Watch", "fa-binoculars");
    watch.addEventListener("click", () => window.open("/room.html?roomId=" + encodeURIComponent(p.roomId) + "&spectate=1", "_blank"));
    bar.appendChild(watch);
    r.appendChild(bar);
    return r;
  }

  // ── Side pane: who is on, and the room map ────────────────────────────────
  function renderSide() {
    if (!els.side || !me) return;
    const side = els.side;
    side.textContent = "";

    side.appendChild(el("div", "dk-side-h", "On now - " + presence.staff.length));
    for (const s of presence.staff) {
      const rank = s.role === "dev" ? "dev" : (s.level || 2) >= 2 ? "l2" : "l1";
      const row = el("div", "dk-staff");
      row.appendChild(el("span", "dk-av sm " + rank, (s.label || "?").charAt(0).toUpperCase()));
      const w = el("div", "dk-staff-w");
      const nameLine = el("div", "dk-staff-n");
      nameLine.appendChild(el("span", null, s.label));
      nameLine.appendChild(el("span", "dk-chip " + rank, rankName(rank)));
      if (s.hidden) nameLine.appendChild(el("span", "dk-chip ghost", "HIDDEN"));
      if (s.vanished) nameLine.appendChild(el("span", "dk-chip ghost", "VANISHED"));
      w.appendChild(nameLine);
      if (s.alias && s.alias !== s.label)
        w.appendChild(el("div", "dk-staff-a", 'as "' + s.alias + '"'));
      const locs = (s.locations || [])
        .map((l) =>
          l.kind === "room" ? "in " + l.roomName
            : l.kind === "watch" ? "watching " + l.roomName
              : l.kind === "dashboard" ? "on the dashboard"
                : "in the lobby",
        )
        .join(" - ");
      w.appendChild(el("div", "dk-staff-l", locs || "around"));
      row.appendChild(w);
      side.appendChild(row);
    }
    if (!presence.staff.length)
      side.appendChild(el("div", "dk-rail-empty", "Nobody is on."));

    side.appendChild(el("div", "dk-side-h", "Rooms - " + presence.rooms.length));
    for (const room of presence.rooms.slice(0, 20)) {
      const row = el("div", "dk-room");
      const top = el("div", "dk-room-t");
      top.appendChild(el("span", "dk-room-n", room.name || "?"));
      if (room.locked) top.appendChild(icon("fa-lock"));
      if (room.slow) top.appendChild(icon("fa-gauge-simple"));
      top.appendChild(el("span", "dk-room-c", String(room.n)));
      row.appendChild(top);
      const meta = el("div", "dk-room-m");
      meta.appendChild(
        el("span", null, room.staff && room.staff.length ? "staff: " + room.staff.join(", ") : "no staff inside"),
      );
      row.appendChild(meta);
      const bar = el("div", "dk-room-b");
      const insp = btn("dk-minib", "Inspect", "fa-eye");
      insp.addEventListener("click", () => openInspector(room.id));
      bar.appendChild(insp);
      const join = btn("dk-minib", "Join", "fa-door-open");
      join.addEventListener("click", () => window.open("/room.html?roomId=" + encodeURIComponent(room.id), "_blank"));
      bar.appendChild(join);
      row.appendChild(bar);
      side.appendChild(row);
    }
    if (!presence.rooms.length)
      side.appendChild(el("div", "dk-rail-empty", "No rooms open right now."));
  }

  // ── Room inspector ────────────────────────────────────────────────────────
  // See into a room and act without joining it. The buttons reuse the same
  // staff events the dashboard fires, so every permission check stays where
  // it already lives - on the server.
  function openInspector(roomId) {
    if (!roomId) return;
    mode = "inspector";
    inspectorRoom = { roomId, loading: true };
    if (els.panel) els.panel.classList.remove("rail-open", "side-open");
    socket.emit("desk room info", { roomId });
    renderMain();
  }

  function renderInspector() {
    const main = els.main;
    if (!main) return;
    main.textContent = "";
    const d = inspectorRoom || {};
    if (els.headSub) els.headSub.textContent = "inspector";

    const bar = el("div", "dk-threadbar");
    const back = btn("dk-minib", "Back", "fa-arrow-left");
    back.addEventListener("click", () => {
      mode = "chat";
      renderAll();
    });
    bar.appendChild(back);
    bar.appendChild(el("span", "dk-threadbar-t", d.name || "Room " + (d.roomId || "")));
    if (d.locked) bar.appendChild(el("span", "dk-chip ghost", "LOCKED"));
    if (d.slow) bar.appendChild(el("span", "dk-chip ghost", "SLOW"));
    const refresh = btn("dk-minib", null, "fa-rotate", "Refresh");
    refresh.addEventListener("click", () => socket.emit("desk room info", { roomId: d.roomId }));
    bar.appendChild(refresh);
    const join = btn("dk-minib", "Join", "fa-door-open");
    join.addEventListener("click", () => window.open("/room.html?roomId=" + encodeURIComponent(d.roomId), "_blank"));
    bar.appendChild(join);
    main.appendChild(bar);

    const list = el("div", "dk-msgs");
    if (d.loading) list.appendChild(el("div", "dk-empty", "Looking..."));
    else if (d.gone) list.appendChild(el("div", "dk-empty", "That room is gone."));
    else if (!d.users || !d.users.length)
      list.appendChild(el("div", "dk-empty", "Nobody in the room."));
    else {
      const canBan = me && (me.role === "dev" || (me.level || 2) >= 2);
      for (const u of d.users) {
        const row = el("div", "dk-occ");
        const head = el("div", "dk-occ-h");
        head.appendChild(el("span", "dk-occ-n", u.username || "?"));
        if (u.isDev) head.appendChild(el("span", "dk-chip dev", "DEV"));
        else if (u.isMod) head.appendChild(el("span", "dk-chip " + ((u.modLevel || 2) >= 2 ? "l2" : "l1"), rankName((u.modLevel || 2) >= 2 ? "l2" : "l1")));
        if (u.location) head.appendChild(el("span", "dk-occ-l", u.location));
        row.appendChild(head);

        // Staff rows get no action buttons; the server refuses anyway, this
        // just keeps the interface honest about it.
        if (!u.isDev && !u.isMod) {
          const acts = el("div", "dk-occ-b");
          const warn = btn("dk-minib", "Warn", "fa-triangle-exclamation");
          warn.addEventListener("click", () =>
            ask(
              {
                title: "Warn " + (u.username || "user"),
                label: "The warning they will see",
                value: "Please follow the room rules.",
                max: 1000,
                icon: '<i class="fas fa-triangle-exclamation"></i>',
              },
              (message) => socket.emit("staff warn", { targetUserId: u.id, message }),
            ),
          );
          acts.appendChild(warn);
          const wipe = btn("dk-minib", "Wipe", "fa-eraser");
          armTwice(wipe, null, () => socket.emit("staff wipe buffer", { targetUserId: u.id }));
          acts.appendChild(wipe);
          const kick = btn("dk-minib danger", "Kick", "fa-user-slash");
          armTwice(kick, null, () => socket.emit("staff kick", { targetUserId: u.id, ban: false }));
          acts.appendChild(kick);
          if (canBan) {
            const kb = btn("dk-minib danger", "Kick + ban", "fa-ban");
            armTwice(kb, null, () => socket.emit("staff kick", { targetUserId: u.id, ban: true }));
            acts.appendChild(kb);
          }
          row.appendChild(acts);
        }
        list.appendChild(row);
      }
    }
    main.appendChild(list);
  }

  // ── Search results ────────────────────────────────────────────────────────
  function renderSearch() {
    const main = els.main;
    if (!main) return;
    main.textContent = "";
    if (els.headSub) els.headSub.textContent = "search";

    const bar = el("div", "dk-threadbar");
    const back = btn("dk-minib", "Back", "fa-arrow-left");
    back.addEventListener("click", () => {
      mode = "chat";
      if (els.searchInput) els.searchInput.value = "";
      renderAll();
    });
    bar.appendChild(back);
    bar.appendChild(el("span", "dk-threadbar-t", "Search"));
    main.appendChild(bar);

    const list = el("div", "dk-msgs");
    if (searchHits == null) list.appendChild(el("div", "dk-empty", "Searching..."));
    else if (!searchHits.length) list.appendChild(el("div", "dk-empty", "Nothing matched."));
    else
      for (const h of searchHits) {
        const row = el("button", "dk-hit");
        row.type = "button";
        const head = el("div", "dk-hit-h");
        head.appendChild(el("span", "dk-hit-w", h.title ? h.title : "#" + h.key));
        head.appendChild(el("span", "dk-mtime", relTime(h.ts) + " ago"));
        row.appendChild(head);
        row.appendChild(el("div", "dk-hit-t", (h.author ? h.author + ": " : "") + h.text));
        row.addEventListener("click", () => jumpTo(h.key, h.ts));
        list.appendChild(row);
      }
    main.appendChild(list);
  }

  // Open the place a search hit lives, landed right on the moment it was
  // said, with the message flashed so the eye finds it.
  function jumpTo(key, ts) {
    view = key.startsWith("t")
      ? { kind: "thread", key }
      : { kind: "channel", key };
    mode = "chat";
    if (els.searchInput) els.searchInput.value = "";
    if (els.panel) els.panel.classList.remove("rail-open", "side-open");
    renderAll();
    socket.emit("desk history", { key, around: ts });
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  // Talkomatic's staff palette throughout: the same blacks, the same #ff9800,
  // the same role colors the dashboard uses. Fonts inherit from the page so
  // the Desk matches wherever it is mounted.
  function injectCss() {
    if (document.getElementById("dk-css")) return;
    const s = document.createElement("style");
    s.id = "dk-css";
    s.textContent = `
.dk-pill{position:fixed;bottom:16px;right:16px;z-index:99988;background:#000;color:#fff;
  border:1px solid #ff9800;border-radius:4px;padding:10px 16px;font-size:13px;font-weight:bold;
  font-family:inherit;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.5);display:inline-flex;
  align-items:center;gap:8px;transition:background .2s,color .2s;}
.dk-pill:hover{background:#ff9800;color:#000;}
.dk-pill.raised{bottom:64px;}
.dk-pill-badge{background:#ff9800;color:#000;border-radius:9px;font-size:11px;line-height:1;
  padding:3px 7px;font-variant-numeric:tabular-nums;}
.dk-pill-badge.loud{background:#ff5468;color:#fff;}
@keyframes dkNudge{0%,100%{transform:translateY(0)}25%{transform:translateY(-4px)}50%{transform:translateY(0)}75%{transform:translateY(-2px)}}
.dk-pill.nudge{animation:dkNudge .5s ease;}
.dk-panel{position:fixed;right:16px;bottom:76px;z-index:99989;display:flex;flex-direction:column;
  width:min(1060px,calc(100vw - 32px));height:min(680px,calc(100vh - 108px));
  background:#202020;border:1px solid #616161;border-radius:8px;overflow:hidden;
  box-shadow:0 18px 55px rgba(0,0,0,.65);color:#fff;font-family:inherit;font-size:14px;}
.dk-panel.dk-offline .dk-head{opacity:.55;}
.dk-panel.dk-offline .dk-head .dk-title-sub::after{content:" - reconnecting";color:#ff5468;}
.dk-head{flex:none;display:flex;align-items:center;gap:8px;padding:9px 12px;
  border-bottom:1px solid #616161;background:linear-gradient(to bottom,#616161,#303030);}
.dk-title{flex:none;display:flex;flex-direction:column;min-width:0;}
.dk-title-main{font-weight:bold;color:#ff9800;font-size:14px;letter-spacing:.4px;}
.dk-title-sub{font-size:11px;color:#ededed;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px;}
.dk-search{flex:1;min-width:0;background:#000;color:#fff;border:1px solid #616161;border-radius:5px;
  padding:7px 10px;font-size:12.5px;font-family:inherit;outline:none;}
.dk-search:focus{border-color:#ff9800;}
.dk-hbtn{flex:none;background:none;border:none;color:#fff;font-size:15px;cursor:pointer;
  padding:6px 8px;border-radius:4px;line-height:1;}
.dk-hbtn:hover{background:#ff9800;color:#000;}
.dk-burger,.dk-msearch{display:none;}
.dk-body{flex:1;display:grid;grid-template-columns:200px minmax(0,1fr) 240px;min-height:0;position:relative;}
.dk-scrim{display:none;position:absolute;inset:0;background:rgba(0,0,0,.6);z-index:4;}
.dk-rail{background:#1b1b1b;border-right:1px solid #333;overflow-y:auto;padding:10px 8px;
  display:flex;flex-direction:column;gap:2px;}
.dk-rail-h{display:flex;align-items:center;font-size:10.5px;font-weight:bold;letter-spacing:.6px;
  text-transform:uppercase;color:#8d8d8d;padding:10px 8px 4px;}
.dk-rail-h:first-child{padding-top:2px;}
.dk-tadd{margin-left:auto;background:none;border:none;color:#8d8d8d;cursor:pointer;font-size:11px;padding:2px 4px;border-radius:3px;}
.dk-tadd:hover{color:#000;background:#ff9800;}
.dk-chan,.dk-thread{display:flex;align-items:center;gap:7px;width:100%;text-align:left;background:none;
  border:none;color:#c3c3c3;font-family:inherit;font-size:13.5px;
  padding:7px 8px;border-radius:4px;cursor:pointer;}
.dk-chan:hover,.dk-thread:hover{background:#242424;color:#fff;}
.dk-chan.on,.dk-thread.on{background:#2e2e2e;color:#fff;font-weight:bold;}
.dk-hash{color:#8d8d8d;font-weight:bold;}
.dk-chan.on .dk-hash,.dk-thread.on .fa-message{color:#ff9800;}
.dk-chan .fa-lock{font-size:9px;color:#8d8d8d;}
.dk-chan-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-b{background:#ff9800;color:#000;border-radius:8px;font-size:10.5px;font-weight:bold;
  padding:2px 6px;font-variant-numeric:tabular-nums;}
.dk-b.loud{background:#ff5468;color:#fff;}
.dk-thread .fa-message{font-size:10px;color:#8d8d8d;}
.dk-thread-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-thread.arch{opacity:.55;}
.dk-dot{width:8px;height:8px;border-radius:50%;background:#ff9800;flex:none;}
.dk-arch-toggle{background:none;border:none;color:#8d8d8d;font-family:inherit;font-size:12px;
  text-align:left;padding:7px 8px;cursor:pointer;}
.dk-arch-toggle:hover{color:#fff;}
.dk-rail-empty{color:#8d8d8d;font-size:12px;padding:6px 8px;}
.dk-rail-foot{margin-top:auto;padding:12px 8px 4px;font-size:10.5px;color:#8d8d8d;line-height:1.5;
  border-top:1px solid #2a2a2a;}
.dk-main{display:flex;flex-direction:column;min-width:0;min-height:0;background:#202020;}
.dk-chandesc{flex:none;padding:8px 14px;font-size:12px;color:#8d8d8d;border-bottom:1px solid #2a2a2a;}
.dk-threadbar{flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 14px;
  border-bottom:1px solid #2a2a2a;}
.dk-threadbar-t{font-weight:bold;}
.dk-threadbar-s{font-size:11.5px;color:#8d8d8d;}
.dk-msgs{flex:1;overflow-y:auto;overflow-x:hidden;padding:10px 14px;display:flex;flex-direction:column;gap:2px;}
.dk-day{text-align:center;font-size:10.5px;font-weight:bold;letter-spacing:.6px;text-transform:uppercase;
  color:#8d8d8d;padding:12px 0 6px;}
.dk-empty{color:#8d8d8d;text-align:center;padding:30px 10px;font-size:13px;}
.dk-older{align-self:center;background:#1b1b1b;border:1px solid #333;color:#c3c3c3;font-family:inherit;
  font-size:12px;padding:5px 12px;border-radius:12px;cursor:pointer;margin-bottom:8px;display:inline-flex;gap:6px;align-items:center;}
.dk-older:hover{border-color:#ff9800;color:#fff;}
.dk-msg{position:relative;padding:2px 8px 2px 46px;border-radius:5px;margin-top:10px;}
.dk-msg.grouped{margin-top:0;}
.dk-msg:hover{background:#242424;}
.dk-msg.mention{background:rgba(255,152,0,.09);}
.dk-msg.mention:hover{background:rgba(255,152,0,.14);}
@keyframes dkFlash{0%,55%{background:rgba(255,152,0,.22)}100%{background:transparent}}
.dk-msg.flash,.dk-sys.flash,.dk-ping.flash{animation:dkFlash 1.8s ease;}
.dk-av{position:absolute;left:4px;top:2px;width:32px;height:32px;border-radius:50%;display:flex;
  align-items:center;justify-content:center;font-weight:bold;font-size:14px;color:#fff;background:#616161;}
.dk-av.sm{position:static;width:26px;height:26px;font-size:12px;flex:none;}
.dk-av.dev{background:#a3323f;}
.dk-av.l2{background:#2b5e9e;}
.dk-av.l1{background:#6d4b9e;}
.dk-mhead{display:flex;align-items:baseline;gap:7px;flex-wrap:wrap;}
.dk-mname{font-weight:bold;}
.dk-chip{font-size:9px;font-weight:bold;letter-spacing:.5px;padding:1px 5px;border-radius:3px;border:1px solid;}
.dk-chip.dev{color:#ff5468;border-color:#ff5468;}
.dk-chip.l2{color:#5aa9ff;border-color:#5aa9ff;}
.dk-chip.l1{color:#c08bff;border-color:#c08bff;}
.dk-chip.ghost{color:#8d8d8d;border-color:#8d8d8d;}
.dk-alias{font-size:11px;color:#8d8d8d;font-style:italic;}
.dk-mtime{font-size:10.5px;color:#8d8d8d;margin-left:auto;font-variant-numeric:tabular-nums;white-space:nowrap;}
.dk-mbody{font-size:13.5px;line-height:1.5;word-break:break-word;white-space:pre-wrap;}
.dk-edited{font-size:10px;color:#8d8d8d;margin-left:5px;}
.dk-tomb{color:#8d8d8d;font-style:italic;font-size:12.5px;}
.dk-hist{background:none;border:none;color:#5aa9ff;font-size:10.5px;cursor:pointer;font-family:inherit;
  padding:0;margin-left:7px;text-decoration:underline;}
.dk-histbox{margin-top:5px;border-left:2px solid #333;padding-left:8px;display:flex;flex-direction:column;gap:3px;}
.dk-histline{font-size:11.5px;color:#c3c3c3;}
.dk-hist-t{color:#8d8d8d;margin-right:7px;font-size:10px;}
.dk-mtools{position:absolute;top:-10px;right:8px;display:none;gap:2px;background:#1b1b1b;
  border:1px solid #333;border-radius:4px;padding:2px;}
.dk-msg:hover .dk-mtools{display:flex;}
.dk-tool{background:none;border:none;color:#c3c3c3;cursor:pointer;font-size:11px;padding:4px 6px;border-radius:3px;}
.dk-tool:hover{background:#333;color:#fff;}
.dk-tool.armed{background:#ff5468;color:#fff;}
.dk-editbox{width:100%;background:#000;color:#fff;border:1px solid #ff9800;border-radius:5px;
  padding:7px 9px;font-family:inherit;font-size:13px;resize:vertical;min-height:40px;}
.dk-sys{display:flex;align-items:baseline;gap:8px;font-size:12px;color:#8d8d8d;padding:5px 8px;margin-top:6px;}
.dk-sys .fas{font-size:11px;flex:none;}
.dk-sys-x{min-width:0;word-break:break-word;}
.dk-sys.card{background:#1b1b1b;border:1px solid #2a2a2a;border-radius:5px;color:#c3c3c3;
  padding:8px 11px;margin-top:8px;font-size:12.5px;line-height:1.5;}
.dk-sys.q-report .fas{color:#5aa9ff;}
.dk-sys.q-appeal .fas{color:#ffb454;}
.dk-sys.q-application .fas{color:#c08bff;}
.dk-sys.q-suggestion .fas{color:#57d9a3;}
.dk-sys.q-abuse .fas{color:#ff5468;}
.dk-sys.q-invite .fas{color:#8d8d8d;}
.dk-sys-t{margin-left:auto;font-size:10px;flex:none;color:#8d8d8d;}
.dk-ping{border:1px solid rgba(255,180,84,.45);border-radius:5px;background:#1b1b1b;
  padding:10px 12px;margin-top:10px;display:flex;flex-direction:column;gap:6px;}
.dk-ping.s-waiting{border-color:rgba(255,84,104,.55);}
.dk-ping.s-claimed{border-color:rgba(90,169,255,.45);}
.dk-ping.s-resolved{border-color:#333;opacity:.75;}
.dk-ping-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.dk-ping-badge{font-size:9px;font-weight:bold;letter-spacing:.6px;padding:2px 6px;border-radius:3px;
  color:#ffb454;border:1px solid #ffb454;}
@keyframes dkPulse{0%,100%{opacity:1}50%{opacity:.45}}
.dk-ping.s-open .dk-ping-badge{animation:dkPulse 1.6s infinite;}
.dk-ping.s-waiting .dk-ping-badge{color:#ff5468;border-color:#ff5468;animation:dkPulse .9s infinite;}
.dk-ping.s-claimed .dk-ping-badge{color:#5aa9ff;border-color:#5aa9ff;animation:none;}
.dk-ping.s-resolved .dk-ping-badge{color:#57d9a3;border-color:#57d9a3;animation:none;}
.dk-ping-t{font-weight:bold;font-size:13.5px;}
.dk-ping-m{display:flex;flex-direction:column;gap:2px;font-size:12px;color:#c3c3c3;}
.dk-ping-staff{color:#8d8d8d;}
.dk-ping-claim{color:#5aa9ff;font-weight:bold;}
.dk-ping-done{color:#57d9a3;}
.dk-ping-acts{border-top:1px dashed #333;padding-top:6px;display:flex;flex-direction:column;gap:2px;}
.dk-ping-act{font-size:11.5px;color:#8d8d8d;}
.dk-ping-b{display:flex;gap:6px;flex-wrap:wrap;}
.dk-minib{display:inline-flex;align-items:center;gap:6px;background:#1b1b1b;border:1px solid #616161;
  color:#fff;font-family:inherit;font-size:12px;font-weight:bold;padding:6px 10px;border-radius:4px;cursor:pointer;}
.dk-minib:hover{border-color:#ff9800;}
.dk-minib.primary{background:#ff9800;border-color:#ff9800;color:#000;}
.dk-minib.primary:hover{background:#ffad33;}
.dk-minib.danger{color:#ff5468;}
.dk-minib.danger:hover{background:#ff5468;border-color:#ff5468;color:#fff;}
.dk-minib.armed{background:#ff5468;border-color:#ff5468;color:#fff;}
.dk-comp{flex:none;display:flex;align-items:flex-end;gap:8px;padding:10px 14px;border-top:1px solid #333;background:#1b1b1b;}
.dk-input{flex:1;min-width:0;background:#000;color:#fff;border:1px solid #616161;border-radius:5px;
  padding:9px 11px;font-family:inherit;font-size:13.5px;resize:none;outline:none;line-height:1.45;max-height:110px;}
.dk-input:focus{border-color:#ff9800;}
.dk-count{flex:none;font-size:10.5px;color:#ffb454;font-variant-numeric:tabular-nums;}
.dk-send{flex:none;background:#ff9800;border:1px solid #ff9800;color:#000;border-radius:5px;
  padding:9px 13px;cursor:pointer;font-size:14px;}
.dk-send:hover{background:#ffad33;}
.dk-side{background:#1b1b1b;border-left:1px solid #333;overflow-y:auto;padding:10px;}
.dk-side-h{font-size:10.5px;font-weight:bold;letter-spacing:.6px;text-transform:uppercase;color:#8d8d8d;
  padding:10px 4px 6px;}
.dk-side-h:first-child{padding-top:2px;}
.dk-staff{display:flex;gap:8px;align-items:flex-start;padding:6px 4px;border-radius:4px;}
.dk-staff:hover{background:#242424;}
.dk-staff-w{min-width:0;flex:1;}
.dk-staff-n{display:flex;align-items:baseline;gap:5px;flex-wrap:wrap;font-size:12.5px;font-weight:bold;}
.dk-staff-a{font-size:11px;color:#8d8d8d;font-style:italic;}
.dk-staff-l{font-size:11px;color:#c3c3c3;}
.dk-room{border:1px solid #2a2a2a;border-radius:5px;padding:7px 9px;margin-bottom:6px;background:#202020;}
.dk-room-t{display:flex;align-items:baseline;gap:6px;font-size:12.5px;}
.dk-room-t .fas{font-size:9px;color:#8d8d8d;}
.dk-room-n{font-weight:bold;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dk-room-c{color:#ff9800;font-weight:bold;font-variant-numeric:tabular-nums;}
.dk-room-m{font-size:10.5px;color:#8d8d8d;margin:3px 0 6px;}
.dk-room-b{display:flex;gap:5px;}
.dk-room-b .dk-minib{padding:4px 8px;font-size:10.5px;}
.dk-occ{border:1px solid #2a2a2a;border-radius:5px;background:#1b1b1b;padding:9px 11px;margin-bottom:7px;}
.dk-occ-h{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
.dk-occ-n{font-weight:bold;}
.dk-occ-l{font-size:11.5px;color:#8d8d8d;}
.dk-occ-b{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;}
.dk-hit{display:block;width:100%;text-align:left;background:#1b1b1b;border:1px solid #2a2a2a;
  border-radius:5px;padding:8px 11px;margin-bottom:6px;color:#fff;font-family:inherit;cursor:pointer;}
.dk-hit:hover{border-color:#ff9800;}
.dk-hit-h{display:flex;align-items:baseline;gap:8px;}
.dk-hit-w{font-weight:bold;color:#ff9800;font-size:12px;}
.dk-hit-t{font-size:12.5px;color:#c3c3c3;margin-top:3px;word-break:break-word;}
.dk-toast{position:absolute;left:50%;bottom:70px;transform:translate(-50%,12px);background:#000;
  border:1px solid #ff9800;color:#fff;font-size:12.5px;padding:8px 14px;border-radius:5px;
  opacity:0;pointer-events:none;transition:opacity .18s,transform .18s;z-index:6;max-width:80%;}
.dk-toast.show{opacity:1;transform:translate(-50%,0);}
.dk-panel.dk-fullpage{position:fixed;inset:0;right:0;bottom:0;width:100%;height:100%;max-height:none;
  border:none;border-radius:0;box-shadow:none;}
button.dk-chan:focus-visible,button.dk-thread:focus-visible,.dk-minib:focus-visible,
.dk-hbtn:focus-visible,.dk-pill:focus-visible,.dk-send:focus-visible{outline:2px solid #ff9800;outline-offset:1px;}
@media (min-width:1001px){
  .dk-people{display:none;}
}
@media (max-width:1000px){
  .dk-body{grid-template-columns:200px minmax(0,1fr);}
  .dk-side{position:absolute;top:0;right:0;bottom:0;width:min(280px,85vw);z-index:5;
    transform:translateX(100%);transition:transform .2s ease;border-left:1px solid #616161;}
  .dk-panel.side-open .dk-side{transform:translateX(0);}
  .dk-panel.side-open .dk-scrim{display:block;}
}
@media (max-width:760px){
  .dk-panel{right:0;bottom:0;width:100vw;height:100vh;height:100dvh;max-height:none;border-radius:0;border:none;}
  .dk-pill.raised{bottom:64px;}
  .dk-body{grid-template-columns:minmax(0,1fr);}
  .dk-search,.dk-popbtn{display:none;}
  .dk-burger,.dk-msearch{display:inline-flex;}
  .dk-title-sub{max-width:120px;}
  .dk-rail{position:absolute;top:0;left:0;bottom:0;width:min(260px,85vw);z-index:5;
    transform:translateX(-100%);transition:transform .2s ease;border-right:1px solid #616161;}
  .dk-panel.rail-open .dk-rail{transform:translateX(0);}
  .dk-panel.rail-open .dk-scrim,.dk-panel.side-open .dk-scrim{display:block;}
  .dk-msg .dk-mtools{display:none;position:static;margin-top:4px;width:max-content;}
  .dk-msg:hover .dk-mtools{display:none;}
  .dk-msg.tools .dk-mtools{display:flex;}
  /* 16px inputs, or iOS zooms the whole page every time the composer opens. */
  .dk-input,.dk-editbox{font-size:16px;}
}
@media (prefers-reduced-motion:reduce){
  .dk-pill.nudge,.dk-ping-badge,.dk-msg.flash,.dk-sys.flash,.dk-ping.flash{animation:none !important;}
  .dk-rail,.dk-side,.dk-toast{transition:none !important;}
}`;
    document.head.appendChild(s);
  }

  // /desk.html carries data-desk-page on its body and no client script of its
  // own, so the Desk builds its own socket there. The keys come from the same
  // localStorage the other pages use; without one, the server stays silent
  // and the page keeps its sign-in note.
  document.addEventListener("DOMContentLoaded", () => {
    if (!document.body || document.body.dataset.deskPage !== "1") return;
    pageMode = true;
    if (typeof window.io !== "function") return;
    init(
      window.io({
        transports: ["websocket"],
        upgrade: false,
        auth: {
          devKey: localStorage.getItem("talkomatic_devKey") || undefined,
          modKey: localStorage.getItem("talkomatic_modKey") || undefined,
          app: "desk",
        },
      }),
    );
  });

  window.TalkoDesk = { init, open: () => setOpen(true), close: () => setOpen(false), toggle };
})();
