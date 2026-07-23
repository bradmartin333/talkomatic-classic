// public/js/mod.js
// Talkomatic moderation dashboard. Connects with the dev/mod key from
// localStorage (the server validates by hash), then drives a tabbed UI:
//   Activity  live, permanent audit feed of staff actions + identity events
//   Ban list  active IP blocks with a live countdown and one-tap unban (dev)
//   Moderators active mod keys with instant revoke + grant (dev)
// Everything rendered with textContent, so it is XSS-safe. The feed batches
// live entries and caps how many cards live in the DOM, so a sudden spike in
// sign-ins cannot thrash the page.

(function () {
  const socket = io({
    auth: {
      devKey: localStorage.getItem("talkomatic_devKey") || undefined,
      modKey: localStorage.getItem("talkomatic_modKey") || undefined,
      // The dashboard is a separate read-only board, exempt from the
      // one-active-tab rule so it can stay open beside a room.
      app: "modlog",
    },
  });

  const $ = (id) => document.getElementById(id);
  const loadingEl = $("loading");
  const deniedEl = $("denied");
  const appEl = $("app");
  const listEl = $("list");
  const searchEl = $("search");
  const meEl = $("meInfo");
  const rosterEl = $("roster");
  const focusBar = $("focusBar");
  const feedNote = $("feedNote");

  // ── State ──
  let entries = []; // oldest first (actions + identity + comments)
  const commentsByRef = new Map(); // parentId -> [comment]
  let me = null;
  let authorized = false;
  let tab = "activity";
  let feedFilter = "all";
  let query = "";
  let focusUid = null;
  let unreadNotifs = 0;
  let applicationsList = [];
  let appsPage = 0;
  let appsFilter = "pending"; // pending | approved | rejected | all
  let appsQuery = "";
  let applicationsOpen = true; // dev kill switch for new mod applications
  const APPS_PAGE = 8;
  let reportsList = [];
  let appealsList = []; // ban appeals (Appeals tab)
  let suggestionsList = []; // feature suggestions (Suggestions tab)
  let invitesList = []; // flagged inviters (Invites tab)
  let invitesPage = 0;
  const INV_PAGE = 12;
  const inviteDetails = new Map(); // deviceId -> last forensic detail

  const DOM_CAP = 250; // max activity cards kept in the DOM at once
  let pendingNew = []; // live entries waiting for the next batched flush
  let flushTimer = null;

  // ── Categories ──
  const CAT = {
    security: {
      color: "#ff5468",
      icon: "fa-user-secret",
      label:
        "Security: a staff key used from a new IP, or from several IPs at once",
    },
    destructive: {
      color: "#ff5468",
      icon: "fa-triangle-exclamation",
      label: "Destructive: kick, ban, IP block, close, nuke, freeze, wipe",
    },
    moderation: {
      color: "#ffb454",
      icon: "fa-gavel",
      label: "Moderation: warn, rename, lock, slow, clear board",
    },
    broadcast: {
      color: "#5aa9ff",
      icon: "fa-bullhorn",
      label: "Broadcast: megaphone, ticker, spotlight, party",
    },
    config: {
      color: "#c08bff",
      icon: "fa-sliders",
      label: "Config and roles: flags, room size, maintenance, grant or revoke",
    },
    signin: {
      color: "#57d9a3",
      icon: "fa-right-to-bracket",
      label: "Identity: a user signed in",
    },
    namechange: {
      color: "#ffb454",
      icon: "fa-user-pen",
      label: "Identity: a name changed or was reset",
    },
    notification: {
      color: "#ff9800",
      icon: "fa-bell",
      label:
        "Inbox: reports, applications, and possible mod-abuse flags (full mods + devs)",
    },
    other: {
      color: "#6b7080",
      icon: "fa-circle-info",
      label: "Other: spectate, staff login, mod note",
    },
  };

  function categorize(e) {
    if (e.type === "security") return "security";
    if (e.type === "notification") return "notification";
    if (e.type === "identity")
      return e.event === "signin" ? "signin" : "namechange";
    const a = (e.action || "").toLowerCase();
    if (/kick|ban|ip block|close room|nuke|freeze|wipe/.test(a))
      return "destructive";
    if (/warn|rename|lock|slow mode|clear board/.test(a)) return "moderation";
    if (/megaphone|ticker|spotlight|party/.test(a)) return "broadcast";
    if (
      /flag|maintenance|grant mod|revoke mod|blacklist|unblock|room size|make mod/.test(
        a,
      )
    )
      return "config";
    return "other";
  }

  // ── Small helpers ──
  const fmtTime = (ts) => {
    try {
      return new Date(ts).toLocaleString();
    } catch (_) {
      return String(ts);
    }
  };
  function span(cls, text) {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    if (text != null) s.textContent = text;
    return s;
  }
  function icon(faClass, cls) {
    const i = document.createElement("i");
    i.className = "fas " + faClass + (cls ? " " + cls : "");
    return i;
  }
  function divc(cls) {
    const d = document.createElement("div");
    if (cls) d.className = cls;
    return d;
  }
  // A centered empty-state block (returns the node; callers append it).
  function emptyBox(faClass, text) {
    const e = divc("empty");
    e.appendChild(icon(faClass));
    e.appendChild(document.createTextNode(text));
    return e;
  }
  function initialOf(name) {
    return (
      String(name || "?")
        .trim()
        .charAt(0) || "?"
    ).toUpperCase();
  }
  function parseTarget(target) {
    const m = /^user:(.*)\(([^)]*)\)$/.exec(target || "");
    return m ? { name: m[1], uid: m[2] } : null;
  }
  function uref(name, uid) {
    const s = span("uref", name);
    if (uid) {
      s.dataset.uid = uid;
      s.title = "Trace this user";
      s.addEventListener("click", () => {
        setFocus(uid);
        switchTab("activity");
      });
    }
    return s;
  }
  function metaBit(parent, k, v, vClass, uid) {
    if (v == null || v === "") return;
    parent.appendChild(span("k", k + " "));
    parent.appendChild(
      uid ? uref(String(v), uid) : span(vClass || null, String(v)),
    );
    parent.appendChild(document.createTextNode("   "));
  }
  function searchable(e) {
    const base = [
      e.role,
      e.label,
      e.action,
      e.event,
      e.target,
      e.room,
      e.ip,
      e.details,
      e.username,
      e.prevUsername,
      e.userId,
      e.by,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    const cmts = (commentsByRef.get(e.id) || [])
      .map((c) => c.text)
      .join(" ")
      .toLowerCase();
    return base + " " + cmts;
  }
  function matchesFocus(e, uid) {
    if (e.type === "identity") return e.userId === uid;
    if (e.type === "action") {
      const t = parseTarget(e.target);
      return t && t.uid === uid;
    }
    return false;
  }
  function passes(e) {
    if (feedFilter !== "all" && e.type !== feedFilter) return false;
    if (focusUid && !matchesFocus(e, focusUid)) return false;
    if (query && !searchable(e).includes(query)) return false;
    return true;
  }

  // ── Activity cards ──
  function buildCard(e) {
    const cat = categorize(e);
    const card = document.createElement("div");
    card.className = "entry cat-" + cat;
    card.dataset.id = e.id;

    const row1 = document.createElement("div");
    row1.className = "row1";
    row1.appendChild(icon(CAT[cat].icon, "cat-ic"));
    if (e.type === "security") {
      row1.appendChild(span("chip dev", "ALERT"));
      row1.appendChild(
        span("who " + (e.role === "dev" ? "dev" : "mod"), e.label || "?"),
      );
      row1.appendChild(
        span(
          "act",
          e.kind === "concurrent"
            ? "key in use from multiple IPs"
            : "key used from a new IP",
        ),
      );
    } else if (e.type === "action") {
      row1.appendChild(
        span(
          "chip " + (e.role === "dev" ? "dev" : "mod"),
          (e.role || "?").toUpperCase(),
        ),
      );
      row1.appendChild(
        span("who " + (e.role === "dev" ? "dev" : "mod"), e.label || "?"),
      );
      row1.appendChild(span("act", e.action || "?"));
    } else if (e.type === "notification") {
      row1.appendChild(span("chip mod", (e.kind || "notice").toUpperCase()));
      if (e.by || e.label) row1.appendChild(span("who", e.by || e.label));
      row1.appendChild(
        span(
          "act",
          e.kind === "abuse"
            ? "possible mod abuse"
            : e.kind === "application"
              ? "mod application"
              : e.kind === "invite"
                ? "invite milestone"
                : e.kind === "suggestion"
                  ? "feature suggestion"
                  : "user report",
        ),
      );
    } else {
      row1.appendChild(uref(e.username || "?", e.userId));
      const evt =
        e.event === "rename"
          ? "changed name"
          : e.event === "forced-rename"
            ? "force-renamed by staff"
            : "signed in";
      row1.appendChild(span("act", evt));
    }
    row1.appendChild(span("when", fmtTime(e.ts)));
    card.appendChild(row1);

    const meta = document.createElement("div");
    meta.className = "meta";
    if (e.type === "security") {
      metaBit(meta, "key:", e.label);
      metaBit(meta, "role:", e.role);
      metaBit(meta, "IP:", e.ip, "ip");
    } else if (e.type === "action") {
      const t = parseTarget(e.target);
      if (t) {
        meta.appendChild(span("k", "target: "));
        meta.appendChild(uref(t.name, t.uid));
        meta.appendChild(document.createTextNode("   "));
      } else {
        metaBit(meta, "target:", e.target);
      }
      metaBit(meta, "room:", e.room);
      metaBit(meta, "by IP:", e.ip, "ip");
    } else if (e.type === "notification") {
      const tn = parseTarget(e.target);
      if (tn) {
        meta.appendChild(span("k", "target: "));
        meta.appendChild(uref(tn.name, tn.uid));
        meta.appendChild(document.createTextNode("   "));
      } else {
        metaBit(meta, "target:", e.target);
      }
      metaBit(meta, "room:", e.room);
    } else {
      metaBit(meta, "was:", e.prevUsername);
      metaBit(meta, "location:", e.location);
      // Show the prior location too when a rename changed it, so the location
      // history is visible on the entry itself, not only in the trace summary.
      metaBit(
        meta,
        "was location:",
        e.prevLocation && e.prevLocation !== e.location
          ? e.prevLocation
          : null,
      );
      metaBit(meta, "IP:", e.ip, "ip");
      metaBit(meta, "user:", e.userId, null, e.userId);
      metaBit(meta, "by:", e.by);
    }
    if (meta.childNodes.length) card.appendChild(meta);

    const detailText =
      e.details || e.detail || (e.type === "notification" ? e.text : null);
    if (detailText) {
      const d = document.createElement("div");
      d.className = "detail";
      d.textContent = detailText;
      card.appendChild(d);
    }

    const thread = document.createElement("div");
    thread.className = "comments";
    thread.style.display = "none";
    card.appendChild(thread);
    (commentsByRef.get(e.id) || []).forEach((c) => appendComment(card, c));

    const box = document.createElement("div");
    box.className = "cmtbox";
    const input = document.createElement("input");
    input.placeholder = "Add a note or ask a question";
    input.maxLength = 500;
    const send = document.createElement("button");
    send.className = "btn sm";
    send.appendChild(icon("fa-paper-plane"));
    const submit = () => {
      const text = input.value.trim();
      if (!text) return;
      socket.emit("audit comment", { entryId: e.id, text });
      input.value = "";
    };
    send.addEventListener("click", submit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") submit();
    });
    box.appendChild(input);
    box.appendChild(send);
    card.appendChild(box);

    return card;
  }

  function appendComment(card, c) {
    const thread = card.querySelector(".comments");
    if (!thread) return;
    thread.style.display = "block";
    const row = document.createElement("div");
    row.className = "cmt";
    row.appendChild(
      span(
        "cwho " + (c.role === "dev" ? "dev" : "mod"),
        (c.label || "?") + ":",
      ),
    );
    row.appendChild(span("ctext", c.text));
    row.appendChild(span("cwhen", fmtTime(c.ts)));
    thread.appendChild(row);
  }

  // Full rebuild of the feed, capped to the most recent DOM_CAP matches and
  // rendered in animation-frame chunks so a long feed never blocks the page.
  let activityToken = 0;
  function renderActivity() {
    pendingNew = [];
    listEl.textContent = "";
    const token = ++activityToken;
    const matches = entries.filter((e) => e.type !== "comment" && passes(e));
    if (matches.length === 0) {
      feedNote.classList.add("hidden");
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.appendChild(icon("fa-inbox"));
      empty.appendChild(document.createTextNode("No matching entries."));
      listEl.appendChild(empty);
      return;
    }
    const shown = matches.slice(-DOM_CAP);
    updateFeedNote(matches.length);
    // Newest first; live inserts still arrive at the top via flushPending.
    let i = shown.length - 1;
    (function chunk() {
      if (token !== activityToken) return; // a newer render superseded this one
      for (let n = 0; i >= 0 && n < 40; i--, n++)
        listEl.appendChild(buildCard(shown[i]));
      if (i >= 0) requestAnimationFrame(chunk);
    })();
  }

  function updateFeedNote(total) {
    if (total > DOM_CAP) {
      feedNote.classList.remove("hidden");
      feedNote.textContent =
        "Showing the latest " +
        DOM_CAP +
        " of " +
        total +
        " matching entries. Use search to narrow down.";
    } else {
      feedNote.classList.add("hidden");
    }
  }

  // Batched insert of new live entries (keeps existing cards, their comments and
  // scroll intact) plus a DOM trim, so a flood of sign-ins can't thrash the page.
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushPending();
    }, 450);
  }
  function flushPending() {
    if (tab !== "activity") {
      pendingNew = [];
      return;
    }
    const toShow = pendingNew.filter(passes);
    pendingNew = [];
    if (toShow.length === 0) return;
    const empty = listEl.querySelector(".empty");
    if (empty) empty.remove();
    // Newest at the top
    for (let i = 0; i < toShow.length; i++) {
      listEl.insertBefore(buildCard(toShow[i]), listEl.firstChild);
    }
    // Trim oldest cards beyond the cap
    let cards = listEl.querySelectorAll(".entry");
    for (let i = cards.length - 1; i >= DOM_CAP; i--) cards[i].remove();
    const totalMatches = entries.filter(
      (e) => e.type !== "comment" && passes(e),
    ).length;
    updateFeedNote(totalMatches);
  }

  // ── Focus (trace a user) ──
  function setFocus(uid) {
    focusUid = uid || null;
    if (!focusUid) {
      focusBar.classList.add("hidden");
      focusBar.textContent = "";
      renderActivity();
      return;
    }
    const s = userSummary(focusUid);
    focusBar.classList.remove("hidden");
    focusBar.textContent = "";
    focusBar.appendChild(icon("fa-crosshairs"));
    focusBar.appendChild(span(null, " Tracing "));
    focusBar.appendChild(span("mono", focusUid));
    const sum = span("sum");
    sum.appendChild(document.createTextNode("   names: "));
    sum.appendChild(boldList(s.names));
    sum.appendChild(document.createTextNode("   locations: "));
    sum.appendChild(boldList(s.locations));
    sum.appendChild(document.createTextNode("   IPs: "));
    sum.appendChild(boldList(s.ips));
    sum.appendChild(document.createTextNode("   actions against them: "));
    const b = document.createElement("b");
    b.textContent = String(s.actionsAgainst);
    sum.appendChild(b);
    focusBar.appendChild(sum);
    const clear = document.createElement("button");
    clear.className = "btn sm";
    clear.appendChild(icon("fa-xmark"));
    clear.appendChild(document.createTextNode(" Clear"));
    clear.addEventListener("click", () => setFocus(null));
    focusBar.appendChild(clear);
    renderActivity();
  }
  function boldList(arr) {
    const b = document.createElement("b");
    b.textContent = arr.length ? arr.join(", ") : "none";
    return b;
  }
  function userSummary(uid) {
    const names = new Set(),
      ips = new Set(),
      locations = new Set();
    let actionsAgainst = 0;
    for (const e of entries) {
      if (e.type === "identity" && e.userId === uid) {
        if (e.username) names.add(e.username);
        if (e.prevUsername) names.add(e.prevUsername);
        if (e.ip) ips.add(e.ip);
        // Location history: every place this user has set on sign-in or rename.
        if (e.location) locations.add(e.location);
        if (e.prevLocation) locations.add(e.prevLocation);
      } else if (e.type === "action") {
        const t = parseTarget(e.target);
        if (t && t.uid === uid) actionsAgainst++;
      }
    }
    return {
      names: [...names],
      ips: [...ips],
      locations: [...locations],
      actionsAgainst,
    };
  }

  function renderRoster(roster) {
    rosterEl.textContent = "";
    if (!roster) return;
    const d = document.createElement("b");
    d.textContent = "Devs: ";
    d.style.color = "var(--red)";
    rosterEl.appendChild(d);
    rosterEl.appendChild(
      document.createTextNode((roster.devs || []).join(", ") || "none"),
    );
    const m = document.createElement("b");
    m.textContent = "      Mods: ";
    m.style.color = "var(--orange)";
    rosterEl.appendChild(m);
    rosterEl.appendChild(
      document.createTextNode((roster.mods || []).join(", ") || "none"),
    );
  }

  function renderLegend() {
    const legendEl = $("legend");
    legendEl.textContent = "";
    Object.keys(CAT).forEach((cat) => {
      const row = document.createElement("div");
      row.className = "leg";
      const ic = icon(CAT[cat].icon, "leg-ic");
      ic.style.color = CAT[cat].color;
      row.appendChild(ic);
      const b = document.createElement("b");
      b.textContent = CAT[cat].label;
      row.appendChild(b);
      legendEl.appendChild(row);
    });
  }

  // ── Ban list tab (dev only) ──
  let bans = [];
  let banHistory = []; // ban/unban events (Bans tab history feed)
  let bansTimer = null;
  function fmtRemaining(b) {
    if (b.permanent) return null;
    const ms = (b.expiry || 0) - Date.now();
    if (ms <= 0) return "expiring";
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    s -= m * 60;
    const pad = (n) => String(n).padStart(2, "0");
    if (d > 0) return d + "d " + pad(h) + ":" + pad(m) + ":" + pad(s) + " left";
    return pad(h) + ":" + pad(m) + ":" + pad(s) + " left";
  }
  // Duration picker to re-time a live block from now (dev). Shortening reduces
  // an over-long ban without lifting it first.
  function openBanDurationMenu(b) {
    if (!window.StaffUI) return;
    const durs = [
      {
        label: "1 hour",
        value: "1h",
        icon: '<i class="fas fa-clock"></i>',
        desc: "Ends 1 hour from now",
      },
      {
        label: "24 hours",
        value: "24h",
        icon: '<i class="fas fa-clock"></i>',
        desc: "Ends 24 hours from now",
      },
      {
        label: "7 days",
        value: "7d",
        icon: '<i class="fas fa-calendar-week"></i>',
        desc: "Ends 7 days from now",
      },
      {
        label: "Permanent",
        value: "permanent",
        icon: '<i class="fas fa-ban"></i>',
        desc: "Never expires",
      },
    ];
    StaffUI.menu({
      title: "Change ban duration",
      icon: '<i class="fas fa-hourglass-half"></i>',
      subtitle: (b.label || b.ip) + " · re-timed from now",
      groups: [
        {
          items: durs.map((d) => ({
            icon: d.icon,
            label: d.label,
            desc: d.desc,
            danger: d.value === "permanent",
            onClick: () =>
              socket.emit("dev set block duration", {
                ip: b.ip,
                duration: d.value,
              }),
          })),
        },
      ],
    });
  }

  // Edit the message a blocked user sees on the ban screen (dev).
  async function editBanMessage(b) {
    if (!window.StaffUI) return;
    const reason = await StaffUI.prompt({
      title: "Ban message",
      icon: '<i class="fas fa-comment"></i>',
      subtitle: "Shown to them on the ban screen when they try to connect",
      fields: [
        {
          name: "value",
          label: "Message (optional)",
          type: "textarea",
          value: b.reason || "",
          placeholder:
            "e.g. Banned for repeated harassment. Contact staff to appeal.",
          maxLength: 500,
        },
      ],
      confirmText: "Save message",
    });
    if (reason == null) return;
    socket.emit("dev set block message", {
      ip: b.ip,
      reason: String(reason).trim(),
    });
  }

  function buildBanCard(b, isDev) {
    const card = divc("bancard" + (b.permanent ? " perm" : ""));
    // Keyed by the opaque ref (mods never receive the IP), used by the live
    // countdown timer to find this ban again.
    card.dataset.ref = b.ref || "";

    // Header: avatar, name, who/when/where meta, live countdown pill
    const head = divc("bc-head");
    const av = divc("avatar");
    av.style.background = b.permanent ? "var(--red)" : "var(--amber)";
    av.textContent = initialOf(b.label || b.ip);
    head.appendChild(av);

    const idc = divc("bc-id");
    idc.appendChild(span("bc-name", b.label || "Unknown user"));
    const meta = divc("bc-meta");
    if (isDev) meta.appendChild(span("ip", b.ip));
    if (b.by) {
      const by = span(null, "");
      by.appendChild(document.createTextNode("by "));
      const bb = document.createElement("b");
      bb.textContent = b.by;
      by.appendChild(bb);
      meta.appendChild(by);
    }
    if (b.ts) {
      const placed = span(null, "placed " + relTime(b.ts));
      placed.title = fmtTime(b.ts);
      meta.appendChild(placed);
    }
    // Repeat-offender count: how many times this IP has ever been banned.
    if (b.bans && b.bans >= 2) {
      const rep = span("bc-repeat");
      rep.appendChild(icon("fa-rotate-right"));
      rep.appendChild(document.createTextNode(" Banned " + b.bans + " times"));
      meta.appendChild(rep);
    }
    idc.appendChild(meta);
    head.appendChild(idc);

    const pill = document.createElement("span");
    pill.className = "pill " + (b.permanent ? "perm" : "live");
    pill.dataset.ttl = "1";
    pill.textContent = b.permanent
      ? "Permanent"
      : fmtRemaining(b) || "expiring";
    head.appendChild(pill);
    card.appendChild(head);

    // The message the blocked user actually sees
    const msg = divc("bc-msg" + (b.reason ? "" : " none"));
    msg.appendChild(span("lbl", "Message shown to them"));
    msg.appendChild(
      document.createTextNode(
        b.reason || "No message set. They see a generic ban screen.",
      ),
    );
    card.appendChild(msg);

    // Accounts seen behind this IP/range, so staff know who a ban hits.
    const seen = divc("bc-msg" + (b.userCount ? "" : " none"));
    seen.appendChild(
      span("lbl", "Seen accounts" + (b.userCount ? " (" + b.userCount + ")" : "")),
    );
    if (b.userCount && b.users && b.users.length) {
      const names = b.users
        .map((u) => u.name || "Unknown")
        .slice(0, 12)
        .join(", ");
      seen.appendChild(document.createTextNode(names));
      if (isDev)
        b.users.slice(0, 12).forEach((u) => {
          const line = span("mono", "");
          line.appendChild(
            document.createTextNode((u.name || "Unknown") + "  id: " + (u.id || "?")),
          );
          if (u.ips && u.ips.length) {
            line.appendChild(document.createTextNode("  IP: "));
            line.appendChild(span("ip", u.ips.join(", ")));
          }
          seen.appendChild(line);
        });
    } else {
      seen.appendChild(
        document.createTextNode("No known accounts for this address yet."),
      );
    }
    card.appendChild(seen);

    // Actions: re-time / edit message (dev), then unban
    const foot = divc("bc-foot");
    if (isDev) {
      const dur = document.createElement("button");
      dur.className = "btn sm";
      dur.appendChild(icon("fa-hourglass-half"));
      dur.appendChild(document.createTextNode(" Change duration"));
      dur.addEventListener("click", () => openBanDurationMenu(b));
      foot.appendChild(dur);

      const editMsg = document.createElement("button");
      editMsg.className = "btn sm";
      editMsg.appendChild(icon("fa-comment"));
      editMsg.appendChild(
        document.createTextNode(b.reason ? " Edit message" : " Add message"),
      );
      editMsg.addEventListener("click", () => editBanMessage(b));
      foot.appendChild(editMsg);
    }
    foot.appendChild(span("spacer"));
    const unban = document.createElement("button");
    unban.className = "btn sm danger";
    unban.appendChild(icon("fa-unlock"));
    unban.appendChild(document.createTextNode(" Unban"));
    unban.addEventListener("click", async () => {
      // A dev sends the IP; a mod (no IP) sends the opaque ref. Send both - the
      // server uses whichever it gets.
      const payload = { ip: b.ip, ref: b.ref };
      if (!window.StaffUI) {
        socket.emit("dev unblock ip", payload);
        return;
      }
      const who = (b.label || "this user") + (b.ip ? " (" + b.ip + ")" : "");
      const ok = await StaffUI.confirm({
        title: "Unban",
        message: "Unblock " + who + "?",
        confirmText: "Unban",
      });
      if (ok) socket.emit("dev unblock ip", payload);
    });
    foot.appendChild(unban);
    card.appendChild(foot);
    return card;
  }

  function renderBans() {
    const wrap = $("bansList");
    const isDev = me && me.role === "dev";
    wrap.textContent = "";
    $("bansBadge").textContent = String(bans.length);
    $("bansSub").textContent = bans.length
      ? bans.length + " active block" + (bans.length === 1 ? "" : "s")
      : "No active blocks";
    if (bans.length === 0) {
      wrap.appendChild(
        emptyBox("fa-circle-check", "Nobody is currently blocked."),
      );
      return;
    }
    bans.forEach((b) => wrap.appendChild(buildBanCard(b, isDev)));
    startBanTimer();
  }
  function startBanTimer() {
    if (bansTimer) return;
    bansTimer = setInterval(() => {
      if (tab !== "bans") return;
      let anyLive = false;
      document.querySelectorAll("#bansList .pill[data-ttl]").forEach((pill) => {
        const ref = pill.closest(".bancard")?.dataset.ref;
        const b = bans.find((x) => x.ref === ref);
        if (!b || b.permanent) return;
        anyLive = true;
        pill.textContent = fmtRemaining(b) || "expiring";
      });
      if (!anyLive) {
        clearInterval(bansTimer);
        bansTimer = null;
      }
    }, 1000);
  }

  // Ban / unban history: who banned or unbanned whom, newest first. The IP only
  // appears for devs (the server omits it for mods).
  function renderBanHistory() {
    const wrap = $("banHistoryList");
    if (!wrap) return;
    wrap.textContent = "";
    const sub = $("banHistSub");
    if (sub)
      sub.textContent = banHistory.length
        ? banHistory.length +
          " recent event" +
          (banHistory.length === 1 ? "" : "s")
        : "No ban activity yet";
    if (!banHistory.length) {
      wrap.appendChild(
        emptyBox("fa-clock-rotate-left", "No ban or unban activity yet."),
      );
      return;
    }
    banHistory.forEach((e) => {
      const isUnban = e.action === "unban";
      const row = divc("bhrow " + (isUnban ? "unban" : "ban"));
      const ic = divc("bh-ic");
      ic.appendChild(icon(isUnban ? "fa-unlock" : "fa-ban"));
      row.appendChild(ic);

      const main = divc("bh-main");
      const line = divc("bh-line");
      const who = document.createElement("b");
      who.textContent = e.by || "A staff member";
      line.appendChild(who);
      line.appendChild(document.createTextNode(" "));
      line.appendChild(
        span(
          isUnban ? "verb-unban" : "verb-ban",
          isUnban ? "unbanned" : "banned",
        ),
      );
      line.appendChild(document.createTextNode(" "));
      const target = document.createElement("b");
      target.textContent = e.name || e.ip || "a user";
      line.appendChild(target);
      if (!isUnban && e.duration) {
        line.appendChild(document.createTextNode(" "));
        line.appendChild(span(null, durationLabel(e.duration)));
      }
      main.appendChild(line);

      const subBits = [];
      if (e.ip) subBits.push("IP " + e.ip); // present for devs only
      if (e.reason) subBits.push('"' + e.reason + '"');
      if (subBits.length) {
        const s = divc("bh-sub");
        s.textContent = subBits.join("   ·   ");
        main.appendChild(s);
      }
      row.appendChild(main);

      const when = span("bh-when", relTime(e.at));
      when.title = fmtTime(e.at);
      row.appendChild(when);

      wrap.appendChild(row);
    });
  }

  // ── Moderators tab (dev only) ──
  let modKeys = [];
  // Turn a last-connected timestamp into a label + freshness colour, so a stale
  // (long-inactive) mod stands out at a glance.
  function lastSeenMeta(ts) {
    if (!ts) return { text: "Never connected", cls: "dim" };
    const ms = Date.now() - ts;
    const day = 86400000;
    let cls = "fresh";
    if (ms >= 7 * day) cls = "cold";
    else if (ms >= day) cls = "stale";
    return { text: relTime(ts), cls };
  }
  // One label/value cell in a mod card's stat grid.
  function modStat(k, v, vCls, title) {
    const s = divc("mc-stat");
    s.appendChild(span("mc-k", k));
    const val = span("mc-v" + (vCls ? " " + vCls : ""), v);
    if (title) val.title = title;
    s.appendChild(val);
    return s;
  }
  function buildModCard(k) {
    const card = divc("modcard");

    const av = divc("avatar");
    av.style.background = "var(--orange)";
    av.textContent = initialOf(k.label);
    card.appendChild(av);

    const main = divc("mc-main");
    const title = divc("mc-title");
    title.appendChild(document.createTextNode(k.label || "mod"));
    title.appendChild(span("chip mod", k.level === 1 ? "MOD L1" : "MOD L2"));
    main.appendChild(title);

    const grid = divc("mc-grid");
    const ls = lastSeenMeta(k.lastSeen);
    grid.appendChild(
      modStat(
        "Last seen",
        ls.text,
        ls.cls,
        k.lastSeen ? fmtTime(k.lastSeen) : null,
      ),
    );
    grid.appendChild(
      modStat(
        "Granted by",
        k.grantedBy || "Unknown",
        k.grantedBy ? null : "dim",
      ),
    );
    grid.appendChild(
      modStat(
        "Granted",
        k.grantedAt ? relTime(k.grantedAt) : "Unknown",
        k.grantedAt ? null : "dim",
        k.grantedAt ? fmtTime(k.grantedAt) : null,
      ),
    );
    grid.appendChild(
      modStat("Key", k.hash ? k.hash.slice(0, 12) + "…" : "?", "mono"),
    );
    main.appendChild(grid);
    card.appendChild(main);

    const actions = divc("rc-actions");

    // Promote (L1 -> L2) / demote (L2 -> L1). Dev only; the tab is dev-gated.
    const toLevel = k.level === 1 ? 2 : 1;
    const levelBtn = document.createElement("button");
    levelBtn.className = "btn sm";
    levelBtn.appendChild(icon(toLevel === 2 ? "fa-arrow-up" : "fa-arrow-down"));
    levelBtn.appendChild(
      document.createTextNode(
        toLevel === 2 ? " Promote to L2" : " Demote to L1",
      ),
    );
    levelBtn.addEventListener("click", async () => {
      if (window.StaffUI) {
        const ok = await StaffUI.confirm({
          title: toLevel === 2 ? "Promote to L2" : "Demote to L1",
          message:
            toLevel === 2
              ? 'Give "' +
                (k.label || "mod") +
                '" full (level 2) powers, including ban and IP block?'
              : 'Limit "' +
                (k.label || "mod") +
                '" to junior (level 1) powers?',
          confirmText: toLevel === 2 ? "Promote" : "Demote",
        });
        if (!ok) return;
      }
      socket.emit("dev set mod level", { hash: k.hash, level: toLevel });
    });
    actions.appendChild(levelBtn);

    const revoke = document.createElement("button");
    revoke.className = "btn sm danger";
    revoke.appendChild(icon("fa-user-xmark"));
    revoke.appendChild(document.createTextNode(" Revoke"));
    revoke.addEventListener("click", async () => {
      if (!window.StaffUI) {
        socket.emit("dev revoke mod", { hash: k.hash });
        return;
      }
      const ok = await StaffUI.confirm({
        title: "Revoke mod",
        message:
          'Revoke "' +
          (k.label || "mod") +
          '" immediately? Their access is removed at once.',
        danger: true,
        confirmText: "Revoke",
      });
      if (ok) socket.emit("dev revoke mod", { hash: k.hash });
    });
    actions.appendChild(revoke);
    card.appendChild(actions);
    return card;
  }
  function renderMods() {
    const wrap = $("modsList");
    wrap.textContent = "";
    $("modsBadge").textContent = String(modKeys.length);
    $("modsSub").textContent = modKeys.length
      ? modKeys.length + " active mod key" + (modKeys.length === 1 ? "" : "s")
      : "No mod keys yet";
    if (modKeys.length === 0) {
      wrap.appendChild(
        emptyBox("fa-user-shield", "No moderators yet. Grant one above."),
      );
      return;
    }
    modKeys.forEach((k) => wrap.appendChild(buildModCard(k)));
  }
  async function grantMod() {
    if (!window.StaffUI) return;
    const r = await StaffUI.prompt({
      title: "Grant a mod key",
      icon: '<i class="fas fa-user-shield"></i>',
      message:
        "Pick a label so this key can be told apart in the log and list. Junior (L1) mods can kick and warn but cannot ban or IP-block - promote them later once they've proven themselves.",
      fields: [
        {
          name: "value",
          label: "Label (a name or handle)",
          type: "text",
          placeholder: "e.g. Zacki",
          required: true,
          maxLength: 40,
        },
        {
          name: "level",
          label: "Level",
          type: "select",
          value: "1",
          options: [
            { value: "1", label: "Junior mod (L1) - limited" },
            { value: "2", label: "Full mod (L2) - all powers" },
          ],
        },
      ],
      confirmText: "Generate key",
    });
    if (r && r.value)
      socket.emit("dev grant mod", { label: r.value, level: Number(r.level) });
  }

  // ── Reports tab (full mods + devs): reported users with quick actions ──
  // Report reason categories, each with a color and icon for the board.
  const REPORT_CATS = {
    spam: { label: "Spam", color: "var(--blue)", icon: "fa-inbox" },
    harassment: {
      label: "Harassment",
      color: "var(--amber)",
      icon: "fa-hand-back-fist",
    },
    hate: { label: "Hate speech", color: "var(--red)", icon: "fa-skull" },
    nsfw: { label: "NSFW", color: "var(--purple)", icon: "fa-image" },
    impersonation: {
      label: "Impersonation",
      color: "var(--blue)",
      icon: "fa-mask",
    },
    threats: {
      label: "Threats",
      color: "var(--red)",
      icon: "fa-triangle-exclamation",
    },
    modabuse: {
      label: "Mod abuse",
      color: "var(--orange)",
      icon: "fa-user-shield",
    },
    other: { label: "Other", color: "var(--dim)", icon: "fa-circle-info" },
  };
  const reportCat = (k) => REPORT_CATS[k] || REPORT_CATS.other;
  const durationLabel = (d) =>
    d === "1h"
      ? "1 hour"
      : d === "24h"
        ? "24 hours"
        : d === "7d"
          ? "7 days"
          : d === "permanent"
            ? "permanently"
            : d;
  function relTime(ts) {
    if (!ts) return "";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    const h = Math.floor(m / 60);
    if (h < 24) return h + "h ago";
    return Math.floor(h / 24) + "d ago";
  }

  function banReported(r, duration) {
    const go = (reason) =>
      socket.emit("staff ip block", {
        targetUserId: r.targetUserId,
        duration,
        reason: reason || "",
      });
    if (!window.StaffUI) return go("");
    StaffUI.prompt({
      title: "IP block " + (r.name || "user"),
      icon: '<i class="fas fa-ban"></i>',
      message:
        "Block this user's IP " +
        durationLabel(duration) +
        (r.online
          ? ". They are disconnected immediately."
          : ". They are offline; the block uses their last known address."),
      fields: [
        {
          name: "value",
          label: "Reason (optional, saved to the ban list)",
          type: "textarea",
          placeholder: "e.g. Repeated harassment after warnings.",
          maxLength: 500,
        },
      ],
      danger: true,
      confirmText: "Block " + durationLabel(duration),
    }).then((reason) => {
      if (reason != null) go(reason);
    });
  }
  // Discard a report: tell the server to clear it, then drop it locally right
  // away so the card disappears without waiting for the round trip.
  function dismissReport(r) {
    socket.emit("staff dismiss report", { targetUserId: r.targetUserId });
    reportsList = reportsList.filter((x) => x.targetUserId !== r.targetUserId);
    renderReports();
  }
  // One "IP block" button opens a duration picker, so the card stays uncluttered.
  function openReportBanMenu(r) {
    if (!window.StaffUI) return banReported(r, "24h");
    const durs = [
      { label: "1 hour", value: "1h", icon: '<i class="fas fa-clock"></i>' },
      { label: "24 hours", value: "24h", icon: '<i class="fas fa-clock"></i>' },
      {
        label: "7 days",
        value: "7d",
        icon: '<i class="fas fa-calendar-week"></i>',
      },
    ];
    if (me && me.role === "dev")
      durs.push({
        label: "Permanent",
        value: "permanent",
        icon: '<i class="fas fa-ban"></i>',
      });
    StaffUI.menu({
      title: "IP block " + (r.name || "user"),
      icon: '<i class="fas fa-ban"></i>',
      subtitle: r.online
        ? "Pick a duration"
        : "Offline; uses their last known address",
      groups: [
        {
          items: durs.map((d) => ({
            icon: d.icon,
            label: d.label,
            danger: true,
            onClick: () => banReported(r, d.value),
          })),
        },
      ],
    });
  }

  function openBanIpDialog() {
    if (!window.StaffUI) return;
    const isDev = me && me.role === "dev";
    const durations = [
      { value: "1h", label: "1 hour" },
      { value: "24h", label: "24 hours" },
      { value: "7d", label: "7 days" },
    ];
    if (isDev) durations.push({ value: "permanent", label: "Permanent" });
    StaffUI.prompt({
      title: "Ban an IP",
      icon: '<i class="fas fa-ban"></i>',
      message: "Blocks the address right away and disconnects anyone on it.",
      fields: [
        {
          name: "ip",
          label: "IP address (IPv4 or IPv6)",
          type: "text",
          required: true,
          placeholder: "e.g. 203.0.113.7 or 2001:db8::1",
        },
        {
          name: "duration",
          label: "Duration",
          type: "select",
          options: durations,
          value: "24h",
        },
        {
          name: "banRange",
          type: "checkbox",
          label: "Also block the whole IPv6 /64 range",
          help: "IPv6 only, stops them rotating their address. No effect on IPv4.",
        },
        {
          name: "reason",
          label: "Message shown to them (optional)",
          type: "textarea",
          maxLength: 500,
          placeholder: "e.g. Ban evasion.",
        },
      ],
      confirmText: "Ban IP",
    }).then((v) => {
      if (!v || !v.ip || !v.ip.trim()) return;
      socket.emit("staff ban ip", {
        ip: v.ip.trim(),
        duration: v.duration || "24h",
        reason: (v.reason || "").trim(),
        banRange: !!v.banRange,
      });
    });
  }

  // Warn a reported user (works whether they are online or offline; the server
  // delivers now or queues it for their next connect).
  async function warnReported(r) {
    if (!window.StaffUI)
      return socket.emit("staff warn user", { targetUserId: r.targetUserId });
    const msg = await StaffUI.prompt({
      title: "Warn " + (r.name || "user"),
      icon: '<i class="fas fa-triangle-exclamation"></i>',
      subtitle: r.online
        ? "They will see it right away"
        : "Saved until they next come online",
      confirmText: "Send warning",
      fields: [
        {
          name: "value",
          label: "Message (optional)",
          placeholder: "Please follow the Talkomatic rules.",
          maxLength: 1000,
        },
      ],
    });
    if (msg == null) return; // cancelled
    socket.emit("staff warn user", {
      targetUserId: r.targetUserId,
      message: String(msg).trim(),
    });
  }

  function renderReports() {
    const wrap = $("reportsList");
    if (!wrap) return;
    wrap.textContent = "";
    const badge = $("reportsBadge");
    if (badge) badge.textContent = String(reportsList.length);
    const sub = $("reportsSub");
    if (sub)
      sub.textContent = reportsList.length
        ? reportsList.length +
          " reported user" +
          (reportsList.length === 1 ? "" : "s")
        : "No reports yet";
    if (!reportsList.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.appendChild(icon("fa-flag"));
      empty.appendChild(document.createTextNode("No reports right now."));
      wrap.appendChild(empty);
      return;
    }

    reportsList.forEach((r) => {
      const hot = r.distinct >= 3;
      const card = document.createElement("div");
      card.className = "report-card" + (hot ? " hot" : "");

      // Header: avatar, name, reporter count, status, last-report time
      const head = document.createElement("div");
      head.className = "rc-head";
      const av = document.createElement("div");
      av.className = "avatar";
      av.style.background = hot ? "var(--red)" : "var(--orange)";
      av.textContent = initialOf(r.name);
      head.appendChild(av);

      const idCol = document.createElement("div");
      idCol.className = "rc-id";
      idCol.appendChild(span("rc-kicker", "Reported user"));
      // The reported user's name traces their activity in the Activity tab.
      const rNameNode = uref(r.name || "user", r.targetUserId);
      rNameNode.classList.add("nm");
      idCol.appendChild(rNameNode);
      const meta = document.createElement("div");
      meta.className = "rc-meta";
      const cnt = span("rbadge " + (hot ? "count" : "warm"));
      cnt.appendChild(icon("fa-user-group"));
      cnt.appendChild(
        document.createTextNode(
          " " + r.distinct + (r.distinct === 1 ? " reporter" : " reporters"),
        ),
      );
      meta.appendChild(cnt);
      const st = span("rbadge " + (r.online ? "on" : "off"));
      st.appendChild(icon(r.online ? "fa-circle" : "fa-moon"));
      st.appendChild(
        document.createTextNode(
          " " +
            (r.online
              ? r.roomName
                ? "in " + r.roomName
                : "online"
              : "offline"),
        ),
      );
      meta.appendChild(st);
      if (r.last)
        meta.appendChild(span(null, "last report " + relTime(r.last)));
      idCol.appendChild(meta);
      // Device id (all staff) and IP (dev-only), same mono line as the appeals card.
      if (r.targetDeviceId || r.ip) {
        const idLine = span("mono", "");
        if (r.targetDeviceId)
          idLine.appendChild(document.createTextNode("id: " + r.targetDeviceId));
        if (r.ip) {
          if (r.targetDeviceId)
            idLine.appendChild(document.createTextNode("   "));
          idLine.appendChild(document.createTextNode("IP: "));
          idLine.appendChild(span("ip", r.ip));
        }
        idCol.appendChild(idLine);
      }
      head.appendChild(idCol);
      card.appendChild(head);

      // Category summary tags, most-used first
      const catEntries = Object.entries(r.categories || {}).sort(
        (a, b) => b[1] - a[1],
      );
      if (catEntries.length) {
        const cats = document.createElement("div");
        cats.className = "rc-cats";
        cats.appendChild(span("lead", "Reported for"));
        catEntries.forEach(([k, v]) => {
          const c = reportCat(k);
          const tag = document.createElement("span");
          tag.className = "ctag";
          tag.style.color = c.color;
          tag.appendChild(icon(c.icon));
          tag.appendChild(document.createTextNode(" " + c.label));
          tag.appendChild(span("n", " x" + v));
          cats.appendChild(tag);
        });
        card.appendChild(cats);
      }

      // What the reported user had typed when they were reported (most recent
      // snapshot). Saved at report time, so staff still see the offending text
      // even after it was cleared or the user left.
      const typedSnap = (r.reasons || [])
        .map((x) => x.targetText)
        .find((t) => t && t.trim());
      const typedBox = divc("rc-typed");
      const typedLbl = divc("lbl");
      typedLbl.appendChild(icon("fa-keyboard"));
      typedLbl.appendChild(
        document.createTextNode(" Their chat box when reported"),
      );
      typedBox.appendChild(typedLbl);
      const typedTxt = divc("txt" + (typedSnap ? "" : " none"));
      typedTxt.textContent = typedSnap
        ? typedSnap
        : "Nothing captured - their chat box was empty.";
      typedBox.appendChild(typedTxt);
      card.appendChild(typedBox);

      // "Who reported" header + one row per reporter, so it is unmistakable
      // that the people listed here are the reporters, not the user above.
      const reasons = r.reasons || [];
      const logHead = document.createElement("div");
      logHead.className = "report-log-head";
      logHead.textContent = "Who reported (" + reasons.length + ")";
      card.appendChild(logHead);
      const log = document.createElement("div");
      log.className = "report-log";
      reasons.forEach((rr) => {
        const c = reportCat(rr.category);
        const item = document.createElement("div");
        item.className = "rlog";
        item.appendChild(span("rl-av", initialOf(rr.by || "?")));
        const m = document.createElement("div");
        m.className = "rl-main";
        const top = document.createElement("div");
        top.className = "rl-top";
        top.appendChild(span("rl-by", rr.by || "Someone"));
        top.appendChild(span("rl-said", "reported for"));
        const cat = span("rl-cat", c.label);
        cat.style.color = c.color;
        cat.style.borderColor = c.color;
        top.appendChild(cat);
        if (rr.at) top.appendChild(span("rl-when", relTime(rr.at)));
        m.appendChild(top);
        m.appendChild(
          span(
            "rl-reason" + (rr.reason ? "" : " none"),
            rr.reason || "No note left",
          ),
        );
        item.appendChild(m);
        log.appendChild(item);
      });
      card.appendChild(log);

      // Footer actions
      const foot = document.createElement("div");
      foot.className = "rc-foot";
      const mkBtn = (label, faIcon, danger, fn) => {
        const b = document.createElement("button");
        b.className = "btn sm" + (danger ? " danger" : "");
        if (faIcon) b.appendChild(icon(faIcon));
        b.appendChild(document.createTextNode((faIcon ? " " : "") + label));
        b.addEventListener("click", fn);
        return b;
      };
      foot.appendChild(
        mkBtn("Warn", "fa-triangle-exclamation", false, () => warnReported(r)),
      );
      if (r.online)
        foot.appendChild(
          mkBtn("Kick", "fa-door-open", false, () =>
            socket.emit("staff kick", { targetUserId: r.targetUserId }),
          ),
        );
      if (r.online || r.canBanOffline)
        foot.appendChild(
          mkBtn("IP block", "fa-ban", true, () => openReportBanMenu(r)),
        );
      else
        foot.appendChild(
          span("note", "Offline with no address on file, cannot block."),
        );
      foot.appendChild(span("spacer"));
      const discard = mkBtn("Discard", "fa-xmark", false, () =>
        dismissReport(r),
      );
      discard.classList.add("rc-discard");
      discard.title = "Clear this report as false or already handled";
      foot.appendChild(discard);
      card.appendChild(foot);

      wrap.appendChild(card);
    });
  }

  // ── Appeals tab (full mods + devs): ban appeals submitted on-site ──
  function appealStatusMeta(a) {
    if (a.status === "resolved") {
      if (a.resolution === "lifted")
        return { badge: "on", icon: "fa-unlock", label: "BAN LIFTED" };
      return { badge: "off", icon: "fa-circle-xmark", label: "DISMISSED" };
    }
    return { badge: "warm", icon: "fa-scale-balanced", label: "OPEN" };
  }
  // Human "ends in ..." for a future ban expiry timestamp.
  function untilLabel(ts) {
    const ms = (ts || 0) - Date.now();
    if (ms <= 0) return "ended";
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    s -= d * 86400;
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const m = Math.floor(s / 60);
    if (d > 0) return "ends in " + d + "d " + h + "h";
    if (h > 0) return "ends in " + h + "h " + m + "m";
    return "ends in " + m + "m";
  }
  function resolveAppeal(a, decision) {
    socket.emit("staff resolve appeal", { id: a.id, decision });
  }

  function renderAppeals() {
    const wrap = $("appealsList");
    if (!wrap) return;
    wrap.textContent = "";
    const open = appealsList.filter((a) => a.status === "open");
    const badge = $("appealsBadge");
    if (badge) badge.textContent = String(open.length);
    const sub = $("appealsSub");
    if (sub)
      sub.textContent = open.length
        ? open.length +
          " open appeal" +
          (open.length === 1 ? "" : "s") +
          (appealsList.length > open.length
            ? "  ·  " + appealsList.length + " total"
            : "")
        : appealsList.length
          ? "No open appeals  ·  " + appealsList.length + " resolved"
          : "No appeals yet";
    if (!appealsList.length) {
      wrap.appendChild(emptyBox("fa-scale-balanced", "No ban appeals yet."));
      return;
    }
    const isDev = me && me.role === "dev";

    appealsList.forEach((a) => {
      const sm = appealStatusMeta(a);
      const card = divc(
        "appealcard" + (a.status === "resolved" ? " resolved" : ""),
      );

      // Header: avatar, name (click to trace), status + still-blocked, time
      const head = divc("ap-head");
      const av = divc("avatar");
      av.style.background = a.status === "open" ? "var(--amber)" : "var(--line)";
      av.textContent = initialOf(a.name);
      head.appendChild(av);
      const idc = divc("ap-id");
      idc.appendChild(span("ap-kicker", "Appealing user"));
      let nameNode;
      if (a.userId) {
        nameNode = uref(a.name || "user", a.userId);
        nameNode.classList.add("nm");
      } else {
        nameNode = span("nm", a.name || "Unknown user");
      }
      idc.appendChild(nameNode);
      const meta = divc("ap-meta");
      const stb = span("rbadge " + sm.badge);
      stb.appendChild(icon(sm.icon));
      stb.appendChild(document.createTextNode(" " + sm.label));
      meta.appendChild(stb);
      const blk = span("rbadge " + (a.stillBlocked ? "off" : "on"));
      blk.appendChild(icon(a.stillBlocked ? "fa-ban" : "fa-unlock"));
      blk.appendChild(
        document.createTextNode(
          a.stillBlocked ? " Still blocked" : " Not blocked",
        ),
      );
      meta.appendChild(blk);
      if (a.at) {
        const t = span(null, "appealed " + relTime(a.at));
        t.title = fmtTime(a.at);
        meta.appendChild(t);
      }
      idc.appendChild(meta);
      head.appendChild(idc);
      card.appendChild(head);

      // Two boxes: the ban being contested, and the user's appeal message
      const grid = divc("ap-grid");

      const contest = divc("ap-box contest");
      const cl = divc("lbl");
      cl.appendChild(icon("fa-ban"));
      cl.appendChild(document.createTextNode(" Ban they are contesting"));
      contest.appendChild(cl);
      const cv = divc("val");
      const banBits = [];
      banBits.push(
        a.banPermanent
          ? "Permanent ban"
          : "Temporary ban" +
              (a.banExpiry ? " (" + untilLabel(a.banExpiry) + ")" : ""),
      );
      if (a.banBy) banBits.push("by " + a.banBy);
      const banLine = document.createElement("div");
      banLine.textContent = banBits.join("  ·  ");
      cv.appendChild(banLine);
      const reasonLine = document.createElement("div");
      reasonLine.style.marginTop = "5px";
      reasonLine.style.color = "var(--dim)";
      reasonLine.textContent = a.banReason
        ? "Reason: " + a.banReason
        : "No ban reason on file.";
      cv.appendChild(reasonLine);
      contest.appendChild(cv);
      grid.appendChild(contest);

      const msg = divc("ap-box");
      const ml = divc("lbl");
      ml.appendChild(icon("fa-comment-dots"));
      ml.appendChild(document.createTextNode(" Their appeal"));
      msg.appendChild(ml);
      const mv = divc("val" + (a.message ? "" : " none"));
      mv.textContent = a.message || "No message.";
      msg.appendChild(mv);
      grid.appendChild(msg);

      card.appendChild(grid);

      // Footer: resolution note (if any) + identity + actions
      const foot = divc("ap-foot");
      const info = divc("ap-info");
      if (a.status === "resolved") {
        info.appendChild(
          span(
            null,
            (a.resolution === "lifted" ? "Ban lifted" : "Dismissed") +
              (a.reviewedBy ? " by " + cleanReviewer(a.reviewedBy) : "") +
              (a.reviewedAt ? " · " + relTime(a.reviewedAt) : ""),
          ),
        );
      }
      if (a.deviceId || a.ip) {
        const idLine = span("mono", "");
        if (a.deviceId)
          idLine.appendChild(document.createTextNode("id: " + a.deviceId));
        if (a.ip) {
          if (a.deviceId) idLine.appendChild(document.createTextNode("   "));
          idLine.appendChild(document.createTextNode("IP: "));
          idLine.appendChild(span("ip", a.ip));
        }
        info.appendChild(idLine);
      }
      foot.appendChild(info);

      if (a.status === "open") {
        const actions = divc("ap-actions");
        if (isDev && a.stillBlocked) {
          const lift = document.createElement("button");
          lift.className = "btn sm primary";
          lift.appendChild(icon("fa-unlock"));
          lift.appendChild(document.createTextNode(" Lift ban"));
          lift.addEventListener("click", async () => {
            if (window.StaffUI) {
              const ok = await StaffUI.confirm({
                title: "Lift ban",
                message:
                  "Unblock " +
                  (a.name || "this user") +
                  "'s IP and accept their appeal?",
                confirmText: "Lift ban",
              });
              if (!ok) return;
            }
            resolveAppeal(a, "lift");
          });
          actions.appendChild(lift);
        }
        const dismiss = document.createElement("button");
        dismiss.className = "btn sm danger";
        dismiss.appendChild(icon("fa-xmark"));
        dismiss.appendChild(document.createTextNode(" Dismiss"));
        dismiss.addEventListener("click", async () => {
          if (window.StaffUI) {
            const ok = await StaffUI.confirm({
              title: "Dismiss appeal",
              danger: true,
              message: "Dismiss this appeal and keep the ban in place?",
              confirmText: "Dismiss",
            });
            if (!ok) return;
          }
          resolveAppeal(a, "dismiss");
        });
        actions.appendChild(dismiss);
        foot.appendChild(actions);
      }
      card.appendChild(foot);
      wrap.appendChild(card);
    });
  }

  function resolveSuggestion(s, decision) {
    socket.emit("staff resolve suggestion", { id: s.id, decision });
  }

  function renderSuggestions() {
    const wrap = $("suggestionsList");
    if (!wrap) return;
    wrap.textContent = "";
    const open = suggestionsList.filter((s) => s.status === "open");
    const badge = $("suggestionsBadge");
    if (badge) badge.textContent = String(open.length);
    const sub = $("suggestionsSub");
    if (sub)
      sub.textContent = open.length
        ? open.length +
          " open suggestion" +
          (open.length === 1 ? "" : "s") +
          (suggestionsList.length > open.length
            ? "  ·  " + suggestionsList.length + " total"
            : "")
        : suggestionsList.length
          ? "No open suggestions  ·  " + suggestionsList.length + " reviewed"
          : "No suggestions yet";
    if (!suggestionsList.length) {
      wrap.appendChild(emptyBox("fa-lightbulb", "No suggestions yet."));
      return;
    }

    suggestionsList.forEach((s) => {
      const card = divc(
        "appealcard" + (s.status === "resolved" ? " resolved" : ""),
      );

      const head = divc("ap-head");
      const av = divc("avatar");
      av.style.background = s.status === "open" ? "var(--amber)" : "var(--line)";
      av.textContent = initialOf(s.name);
      head.appendChild(av);
      const idc = divc("ap-id");
      idc.appendChild(span("ap-kicker", "Suggested by"));
      let nameNode;
      if (s.userId) {
        nameNode = uref(s.name || "user", s.userId);
        nameNode.classList.add("nm");
      } else {
        nameNode = span("nm", s.name || "A user");
      }
      idc.appendChild(nameNode);
      const meta = divc("ap-meta");
      if (s.at) {
        const t = span(null, "sent " + relTime(s.at));
        t.title = fmtTime(s.at);
        meta.appendChild(t);
      }
      idc.appendChild(meta);
      head.appendChild(idc);
      card.appendChild(head);

      const box = divc("ap-box");
      const bl = divc("lbl");
      bl.appendChild(icon("fa-lightbulb"));
      bl.appendChild(document.createTextNode(" Suggestion"));
      box.appendChild(bl);
      const bv = divc("val" + (s.text ? "" : " none"));
      bv.textContent = s.text || "No text.";
      box.appendChild(bv);
      card.appendChild(box);

      const foot = divc("ap-foot");
      const info = divc("ap-info");
      if (s.status === "resolved") {
        info.appendChild(
          span(
            null,
            (s.resolution === "approved" ? "Approved" : "Declined") +
              (s.reviewedBy ? " by " + cleanReviewer(s.reviewedBy) : "") +
              (s.reviewedAt ? " · " + relTime(s.reviewedAt) : ""),
          ),
        );
      }
      foot.appendChild(info);

      if (s.status === "open") {
        const actions = divc("ap-actions");
        const approve = document.createElement("button");
        approve.className = "btn sm primary";
        approve.appendChild(icon("fa-check"));
        approve.appendChild(document.createTextNode(" Approve"));
        approve.addEventListener("click", async () => {
          if (window.StaffUI) {
            const ok = await StaffUI.confirm({
              title: "Approve suggestion",
              message: "Mark this suggestion as approved?",
              confirmText: "Approve",
            });
            if (!ok) return;
          }
          resolveSuggestion(s, "approve");
        });
        actions.appendChild(approve);
        const decline = document.createElement("button");
        decline.className = "btn sm danger";
        decline.appendChild(icon("fa-xmark"));
        decline.appendChild(document.createTextNode(" Decline"));
        decline.addEventListener("click", async () => {
          if (window.StaffUI) {
            const ok = await StaffUI.confirm({
              title: "Decline suggestion",
              danger: true,
              message: "Decline this suggestion?",
              confirmText: "Decline",
            });
            if (!ok) return;
          }
          resolveSuggestion(s, "decline");
        });
        actions.appendChild(decline);
        foot.appendChild(actions);
      }
      card.appendChild(foot);
      wrap.appendChild(card);
    });
  }

  // ── Invites tab (full mods + devs): flag and clean farmed invites ──
  function verdictMeta(level) {
    if (level === "likely_farmed")
      return { cls: "farmed", label: "Likely farmed", icon: "fa-robot" };
    if (level === "suspicious")
      return {
        cls: "suspicious",
        label: "Suspicious",
        icon: "fa-circle-question",
      };
    return { cls: "clean", label: "Looks clean", icon: "fa-circle-check" };
  }

  // Confirm, then ask the server to soft-delete a flagged cluster (or all
  // flagged invites) for one inviter. The server re-checks the flag and logs it.
  async function confirmPurge(it, cohort, count) {
    if (!window.StaffUI) return;
    const go = await StaffUI.confirm({
      title: "Remove farmed invites",
      danger: true,
      confirmText: "Remove " + count,
      message:
        "Remove " +
        count +
        " pending invite" +
        (count === 1 ? "" : "s") +
        " from " +
        (it.name || "this inviter") +
        "? Active invites are never touched. This is logged, and a developer can undo it.",
    });
    if (!go) return;
    socket.emit("staff purge invites", { deviceId: it.deviceId, cohort });
  }

  // The expanded forensic detail for one inviter: a cadence + conversion
  // summary, each same-address cluster with its own Remove button, and (for
  // devs) an undo of the last removal.
  function buildInviteDetail(it, d, isDev) {
    const box = document.createElement("div");
    box.className = "inv-detail";

    const sum = document.createElement("div");
    sum.className = "sumline";
    const parts = [];
    if (d.medianGapMs != null)
      parts.push("~" + (d.medianGapMs / 1000).toFixed(1) + "s between invites");
    parts.push((d.activePct || 0) + "% became active");
    parts.push((d.namedPct || 0) + "% ever named");
    sum.textContent = parts.join("   ·   ");
    box.appendChild(sum);

    if (!d.cohorts || !d.cohorts.length) {
      const none = document.createElement("div");
      none.className = "inv-none";
      none.textContent =
        "No same-address cluster large enough to remove as a group.";
      box.appendChild(none);
    } else {
      const head = document.createElement("div");
      head.className = "report-log-head";
      head.style.padding = "0 0 6px";
      head.textContent = "Same-address clusters";
      box.appendChild(head);
      d.cohorts.forEach((c) => {
        const row = document.createElement("div");
        row.className = "cohort-row";
        const info = span("cinfo");
        const b = document.createElement("b");
        b.textContent = c.count + " invite" + (c.count === 1 ? "" : "s");
        info.appendChild(b);
        info.appendChild(document.createTextNode(" from one address"));
        if (isDev && c.ip) {
          info.appendChild(document.createTextNode(" "));
          info.appendChild(span("ip", c.ip));
        }
        row.appendChild(info);
        const rm = document.createElement("button");
        rm.className = "btn sm danger";
        rm.appendChild(icon("fa-trash"));
        rm.appendChild(document.createTextNode(" Remove " + c.count));
        rm.addEventListener("click", () => confirmPurge(it, c.index, c.count));
        row.appendChild(rm);
        box.appendChild(row);
      });
    }

    if (isDev && d.lastBatch) {
      const undo = document.createElement("button");
      undo.className = "btn sm";
      undo.style.marginTop = "10px";
      undo.appendChild(icon("fa-rotate-left"));
      undo.appendChild(document.createTextNode(" Undo last removal"));
      undo.addEventListener("click", () =>
        socket.emit("staff undo invite purge", {
          deviceId: it.deviceId,
          batch: d.lastBatch,
        }),
      );
      box.appendChild(undo);
    }
    return box;
  }

  function renderInvites() {
    const wrap = $("invitesList");
    if (!wrap) return;
    wrap.textContent = "";
    const badge = $("invitesBadge");
    if (badge) badge.textContent = String(invitesList.length);
    const sub = $("invitesSub");
    if (sub)
      sub.textContent = invitesList.length
        ? invitesList.length +
          " flagged inviter" +
          (invitesList.length === 1 ? "" : "s")
        : "No flagged inviters";
    if (!invitesList.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.appendChild(icon("fa-trophy"));
      empty.appendChild(
        document.createTextNode(
          "No farmed invites detected. The board is clean.",
        ),
      );
      wrap.appendChild(empty);
      return;
    }
    const isDev = me && me.role === "dev";
    const pages = Math.max(1, Math.ceil(invitesList.length / INV_PAGE));
    if (invitesPage >= pages) invitesPage = pages - 1;
    if (invitesPage < 0) invitesPage = 0;
    const start = invitesPage * INV_PAGE;
    invitesList.slice(start, start + INV_PAGE).forEach((it) => {
      const vm = verdictMeta(it.verdict && it.verdict.level);
      const card = document.createElement("div");
      card.className = "report-card" + (vm.cls === "farmed" ? " hot" : "");

      const head = document.createElement("div");
      head.className = "rc-head";
      const av = document.createElement("div");
      av.className = "avatar";
      av.style.background =
        vm.cls === "farmed" ? "var(--red)" : "var(--orange)";
      av.textContent = initialOf(it.name);
      head.appendChild(av);
      const idCol = document.createElement("div");
      idCol.className = "rc-id";
      idCol.appendChild(span("rc-kicker", "Inviter"));
      idCol.appendChild(span("nm", it.name || "Anonymous"));
      const meta = document.createElement("div");
      meta.className = "rc-meta";
      const v = span("verdict " + vm.cls);
      v.appendChild(icon(vm.icon));
      v.appendChild(document.createTextNode(" " + vm.label));
      meta.appendChild(v);
      if (it.location) meta.appendChild(span(null, it.location));
      idCol.appendChild(meta);
      head.appendChild(idCol);
      card.appendChild(head);

      const stats = document.createElement("div");
      stats.className = "inv-stats";
      const chip = (label, val) => {
        const s = span("st");
        s.appendChild(document.createTextNode(label + " "));
        const b = document.createElement("b");
        b.textContent = String(val);
        s.appendChild(b);
        return s;
      };
      stats.appendChild(chip("pending", it.pending));
      stats.appendChild(chip("active", it.active));
      stats.appendChild(chip("distinct IPs", it.distinctIps));
      stats.appendChild(chip("top address", (it.topIpPct || 0) + "%"));
      stats.appendChild(chip("named", (it.namedPct || 0) + "%"));
      card.appendChild(stats);

      if (it.verdict && it.verdict.reasons && it.verdict.reasons.length) {
        const ul = document.createElement("ul");
        ul.className = "inv-reasons";
        it.verdict.reasons.forEach((r) => {
          const li = document.createElement("li");
          li.textContent = r;
          ul.appendChild(li);
        });
        card.appendChild(ul);
      }

      const detail = inviteDetails.get(it.deviceId);
      const foot = document.createElement("div");
      foot.className = "rc-foot";
      if (!detail) {
        const investigate = document.createElement("button");
        investigate.className = "btn sm";
        investigate.appendChild(icon("fa-magnifying-glass"));
        investigate.appendChild(document.createTextNode(" Investigate"));
        investigate.addEventListener("click", () =>
          socket.emit("staff get invite report", { deviceId: it.deviceId }),
        );
        foot.appendChild(investigate);
      }
      if (it.pending > 0) {
        const purgeAll = document.createElement("button");
        purgeAll.className = "btn sm danger";
        purgeAll.appendChild(icon("fa-broom"));
        purgeAll.appendChild(
          document.createTextNode(" Remove all flagged (" + it.pending + ")"),
        );
        purgeAll.addEventListener("click", () =>
          confirmPurge(it, "all", it.pending),
        );
        foot.appendChild(purgeAll);
      }
      card.appendChild(foot);

      if (detail) card.appendChild(buildInviteDetail(it, detail, isDev));

      wrap.appendChild(card);
    });

    if (pages > 1) {
      const pager = document.createElement("div");
      pager.className = "inv-pager";
      const nav = (label, faIcon, atEnd, disabled, delta) => {
        const b = document.createElement("button");
        b.className = "btn sm";
        b.disabled = disabled;
        if (!atEnd) b.appendChild(icon(faIcon));
        b.appendChild(document.createTextNode(label));
        if (atEnd) b.appendChild(icon(faIcon));
        if (!disabled)
          b.addEventListener("click", () => {
            invitesPage += delta;
            renderInvites();
          });
        return b;
      };
      pager.appendChild(
        nav(" Prev", "fa-chevron-left", false, invitesPage === 0, -1),
      );
      pager.appendChild(
        span(null, "Page " + (invitesPage + 1) + " of " + pages),
      );
      pager.appendChild(
        nav("Next ", "fa-chevron-right", true, invitesPage >= pages - 1, 1),
      );
      wrap.appendChild(pager);
    }
  }

  // ── Applications tab (full mods + devs) ──
  // Status colour, badge tone, header icon, and avatar tint for one application.
  function appStatusMeta(status) {
    if (status === "approved")
      return {
        cls: "st-approved",
        badge: "on",
        icon: "fa-circle-check",
        av: "var(--green)",
      };
    if (status === "rejected")
      return {
        cls: "st-rejected",
        badge: "off",
        icon: "fa-circle-xmark",
        av: "#3a3f4a",
      };
    return {
      cls: "st-pending",
      badge: "warm",
      icon: "fa-hourglass-half",
      av: "var(--orange)",
    };
  }
  // reviewedBy is stored as "dev:Label" / "mod:Label"; show just the label.
  function cleanReviewer(s) {
    s = String(s || "");
    const i = s.indexOf(":");
    return (i >= 0 ? s.slice(i + 1) : s) || s;
  }
  // One labelled answer block (question + the applicant's answer).
  function qaBlock(ic, label, text) {
    const b = divc("qa");
    const q = divc("qa-q");
    q.appendChild(icon(ic));
    q.appendChild(document.createTextNode(" " + label));
    b.appendChild(q);
    const a = divc("qa-a" + (text ? "" : " none"));
    a.textContent = text || "Not provided";
    b.appendChild(a);
    return b;
  }
  // Generic Prev / Next pager (shared by the Applications list).
  function buildPager(page, pages, onGo) {
    const pager = divc("pager");
    const mk = (label, faIcon, atEnd, disabled, target) => {
      const b = document.createElement("button");
      b.className = "btn sm";
      b.disabled = disabled;
      if (!atEnd) b.appendChild(icon(faIcon));
      b.appendChild(document.createTextNode(label));
      if (atEnd) b.appendChild(icon(faIcon));
      if (!disabled) b.addEventListener("click", () => onGo(target));
      return b;
    };
    pager.appendChild(
      mk(" Prev", "fa-chevron-left", false, page === 0, page - 1),
    );
    pager.appendChild(span(null, "Page " + (page + 1) + " of " + pages));
    pager.appendChild(
      mk("Next ", "fa-chevron-right", true, page >= pages - 1, page + 1),
    );
    return pager;
  }

  function buildAppCard(a) {
    const sm = appStatusMeta(a.status);
    const card = divc("appcard " + sm.cls);

    // Header: avatar, applicant name, status badge, applied-time
    const head = divc("ac-head");
    const av = divc("avatar");
    av.style.background = sm.av;
    av.textContent = initialOf(a.username);
    head.appendChild(av);
    const idc = divc("ac-id");
    idc.appendChild(span("ac-kicker", "Mod applicant"));
    idc.appendChild(span("ac-name", a.username || "Anonymous"));
    const meta = divc("ac-meta");
    const badge = span("rbadge " + sm.badge);
    badge.appendChild(icon(sm.icon));
    badge.appendChild(
      document.createTextNode(" " + (a.status || "pending").toUpperCase()),
    );
    meta.appendChild(badge);
    if (a.submittedAt) {
      const t = span(null, "applied " + relTime(a.submittedAt));
      t.title = fmtTime(a.submittedAt);
      meta.appendChild(t);
    }
    idc.appendChild(meta);
    head.appendChild(idc);
    card.appendChild(head);

    // The two application answers, each clearly labelled
    const qa = divc("ac-qa");
    qa.appendChild(
      qaBlock(
        "fa-circle-question",
        "Why they want to help",
        (a.answers && a.answers.why) || "",
      ),
    );
    qa.appendChild(
      qaBlock(
        "fa-clock",
        "Availability",
        (a.answers && a.answers.availability) || "",
      ),
    );
    card.appendChild(qa);

    // Footer: review outcome + identity, then the action buttons
    const foot = divc("ac-foot");
    const info = divc("ac-info");
    if (a.status !== "pending" && (a.reviewedBy || a.reviewedAt || a.reason)) {
      const rline = span(null, "");
      rline.appendChild(
        document.createTextNode(
          (a.status === "approved" ? "Approved" : "Rejected") + " ",
        ),
      );
      if (a.reviewedBy) {
        rline.appendChild(document.createTextNode("by "));
        const b = document.createElement("b");
        b.textContent = cleanReviewer(a.reviewedBy);
        rline.appendChild(b);
      }
      if (a.reviewedAt) {
        const w = span(null, " · " + relTime(a.reviewedAt));
        w.title = fmtTime(a.reviewedAt);
        rline.appendChild(w);
      }
      info.appendChild(rline);
      if (a.reason) info.appendChild(span(null, "Reason: " + a.reason));
      if (a.status === "approved")
        info.appendChild(
          span(null, a.claimed ? "Key claimed" : "Key pending claim"),
        );
    }
    // Identity line: device id for all staff, raw IP only when the server sent
    // one (dev-only), matching the reports board and audit feed.
    if (a.deviceId || a.ip) {
      const idLine = span("mono", "");
      if (a.deviceId)
        idLine.appendChild(document.createTextNode("id: " + a.deviceId));
      if (a.ip) {
        if (a.deviceId) idLine.appendChild(document.createTextNode("   "));
        idLine.appendChild(document.createTextNode("IP: "));
        idLine.appendChild(span("ip", a.ip));
      }
      info.appendChild(idLine);
    }
    foot.appendChild(info);

    if (a.status === "pending") {
      const actions = divc("ac-actions");
      const approve = document.createElement("button");
      approve.className = "btn sm primary";
      approve.appendChild(icon("fa-check"));
      approve.appendChild(document.createTextNode(" Approve (L1)"));
      approve.addEventListener("click", async () => {
        let msg = "";
        if (window.StaffUI) {
          msg = await StaffUI.prompt({
            title: "Approve application",
            icon: '<i class="fas fa-check"></i>',
            subtitle: a.username || "this user",
            message:
              "Approve " +
              (a.username || "this user") +
              " as a junior (L1) moderator? They get a mod key right away.",
            fields: [
              {
                name: "value",
                label: "Message to the applicant (optional, they will see it)",
                type: "text",
                maxLength: 300,
              },
            ],
            confirmText: "Approve",
          });
          if (msg === null) return; // cancelled
        }
        socket.emit("mod application review", {
          id: a.id,
          decision: "approve",
          reason: msg || "",
        });
      });
      const reject = document.createElement("button");
      reject.className = "btn sm danger";
      reject.appendChild(icon("fa-xmark"));
      reject.appendChild(document.createTextNode(" Reject"));
      reject.addEventListener("click", async () => {
        let reason = "";
        if (window.StaffUI) {
          reason = await StaffUI.prompt({
            title: "Reject application",
            icon: '<i class="fas fa-xmark"></i>',
            subtitle: a.username || "this user",
            fields: [
              {
                name: "value",
                label: "Message to the applicant (optional, they will see it)",
                type: "text",
                maxLength: 300,
              },
            ],
            confirmText: "Reject",
          });
          if (reason === null) return;
        }
        socket.emit("mod application review", {
          id: a.id,
          decision: "reject",
          reason: reason || "",
        });
      });
      actions.appendChild(approve);
      actions.appendChild(reject);
      foot.appendChild(actions);
    }
    card.appendChild(foot);
    return card;
  }

  // Dev-only Close/Open button for the application intake. Mods see only the
  // closed state reflected in the sub-line.
  function renderApplicationsToggle() {
    const btn = $("appsToggle");
    if (!btn) return;
    const isDev = me && me.role === "dev";
    btn.style.display = isDev ? "" : "none";
    if (!isDev) return;
    btn.innerHTML = applicationsOpen
      ? '<i class="fas fa-lock"></i> Close applications'
      : '<i class="fas fa-lock-open"></i> Open applications';
    btn.classList.toggle("danger", applicationsOpen);
    btn.title = applicationsOpen
      ? "Stop accepting new moderator applications"
      : "Resume accepting new moderator applications";
  }

  function renderApps() {
    const wrap = $("appsList");
    if (!wrap) return;
    renderApplicationsToggle();
    wrap.textContent = "";
    const pending = applicationsList.filter((a) => a.status === "pending");
    const badge = $("appsBadge");
    if (badge) badge.textContent = String(pending.length);
    const sub = $("appsSub");
    if (sub) {
      sub.textContent = pending.length
        ? pending.length +
          " awaiting review" +
          (applicationsList.length > pending.length
            ? "  ·  " + applicationsList.length + " total"
            : "")
        : applicationsList.length
          ? "No applications awaiting review  ·  " +
            applicationsList.length +
            " total"
          : "No applications yet";
      if (!applicationsOpen) sub.textContent += "  ·  CLOSED to new applications";
    }

    if (applicationsList.length === 0) {
      wrap.appendChild(emptyBox("fa-user-pen", "No applications yet."));
      return;
    }

    // Filter by the active status segment, then by the search box.
    let list = applicationsList.slice();
    if (appsFilter !== "all")
      list = list.filter((a) => (a.status || "pending") === appsFilter);
    if (appsQuery)
      list = list.filter((a) =>
        [
          a.username,
          a.answers && a.answers.why,
          a.answers && a.answers.availability,
          a.reason,
          a.reviewedBy,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(appsQuery),
      );

    if (list.length === 0) {
      wrap.appendChild(
        emptyBox(
          "fa-filter-circle-xmark",
          appsQuery
            ? "No applications match your search."
            : "No " +
                (appsFilter === "all" ? "" : appsFilter + " ") +
                "applications.",
        ),
      );
      return;
    }

    const pages = Math.max(1, Math.ceil(list.length / APPS_PAGE));
    if (appsPage >= pages) appsPage = pages - 1;
    if (appsPage < 0) appsPage = 0;
    const start = appsPage * APPS_PAGE;
    list
      .slice(start, start + APPS_PAGE)
      .forEach((a) => wrap.appendChild(buildAppCard(a)));
    if (pages > 1)
      wrap.appendChild(
        buildPager(appsPage, pages, (p) => {
          appsPage = p;
          renderApps();
        }),
      );
  }

  // ── Sessions tab (dev only): who is connected on which staff key ──
  let sessionData = { sessions: [], history: [] };
  function keyRow(label, role, ipsText, pillClass, pillText, sub2) {
    const row = document.createElement("div");
    row.className = "rowcard";
    const av = document.createElement("div");
    av.className = "avatar";
    av.style.background = role === "dev" ? "var(--red)" : "var(--orange)";
    av.textContent = initialOf(label);
    row.appendChild(av);
    const main = document.createElement("div");
    main.className = "rc-main";
    const title = span("rc-title", "");
    title.appendChild(document.createTextNode(label || "?"));
    title.appendChild(
      span(
        "chip " + (role === "dev" ? "dev" : "mod"),
        (role || "?").toUpperCase(),
      ),
    );
    main.appendChild(title);
    const sub = span("rc-sub", "");
    if (sub2) sub.appendChild(document.createTextNode(sub2 + " "));
    sub.appendChild(span("ip", ipsText || "none"));
    main.appendChild(sub);
    row.appendChild(main);
    const actions = document.createElement("div");
    actions.className = "rc-actions";
    const pill = document.createElement("span");
    pill.className = "pill " + pillClass;
    pill.textContent = pillText;
    actions.appendChild(pill);
    row.appendChild(actions);
    return row;
  }
  function emptyCard(wrap, ic, text) {
    const e = document.createElement("div");
    e.className = "empty";
    e.appendChild(icon(ic));
    e.appendChild(document.createTextNode(text));
    wrap.appendChild(e);
  }
  function renderSessions() {
    const active = $("sessionsActive");
    const hist = $("sessionsHistory");
    const sessions = sessionData.sessions || [];
    const history = sessionData.history || [];
    const flagged = sessions.filter((s) => s.multiIp).length;
    $("sessionsBadge").textContent = String(sessions.length);
    $("sessionsSub").textContent = sessions.length
      ? sessions.length +
        " key" +
        (sessions.length === 1 ? "" : "s") +
        " connected" +
        (flagged ? ", " + flagged + " from multiple IPs" : "")
      : "No staff connected right now";

    active.textContent = "";
    if (sessions.length === 0) {
      emptyCard(
        active,
        "fa-plug-circle-xmark",
        "No staff are connected right now.",
      );
    } else {
      sessions.forEach((s) => {
        const tabs =
          (s.sessionCount || 1) +
          " tab" +
          ((s.sessionCount || 1) === 1 ? "" : "s") +
          " from";
        active.appendChild(
          keyRow(
            s.label,
            s.role,
            (s.ips || []).join(", "),
            s.multiIp ? "perm" : "live",
            s.multiIp ? "Multiple IPs" : "OK",
            tabs,
          ),
        );
      });
    }

    hist.textContent = "";
    if (history.length === 0) {
      emptyCard(hist, "fa-clock-rotate-left", "No key history yet.");
    } else {
      history.forEach((h) => {
        const ips = h.ips || [];
        hist.appendChild(
          keyRow(
            h.label,
            h.role,
            ips.map((x) => x.ip).join(", "),
            ips.length > 1 ? "perm" : "live",
            ips.length + " IP" + (ips.length === 1 ? "" : "s"),
            "seen from",
          ),
        );
      });
    }
  }

  // ── Tabs + sidebar ──
  function switchTab(name) {
    tab = name;
    document
      .querySelectorAll(".nav-item")
      .forEach((n) => n.classList.toggle("active", n.dataset.tab === name));
    document
      .querySelectorAll(".panel")
      .forEach((p) => p.classList.remove("active"));
    const panel = $("tab-" + name);
    if (panel) panel.classList.add("active");
    if (name === "activity") flushPending();
    if (name === "bans") {
      socket.emit("dev list blocks");
      socket.emit("staff get ban history");
      startBanTimer();
    }
    if (name === "mods") socket.emit("dev list mod keys");
    if (name === "sessions") socket.emit("dev get sessions");
    if (name === "applications") socket.emit("mod applications list");
    if (name === "reports") socket.emit("staff get reports");
    if (name === "appeals") socket.emit("staff get appeals");
    if (name === "suggestions") socket.emit("staff get suggestions");
    if (name === "invites") socket.emit("staff get invite report");
    if (window.innerWidth <= 860) document.body.classList.add("nav-closed");
  }
  function updateNotifBadge() {
    const b = document.getElementById("notifCount");
    if (!b) return;
    b.textContent = unreadNotifs > 0 ? String(unreadNotifs) : "";
    b.style.display = unreadNotifs > 0 ? "" : "none";
  }

  function applyRoleGating() {
    const isDev = me && me.role === "dev";
    const fullMod = isDev || (me && (me.modLevel || 2) >= 2);
    document.querySelectorAll(".nav-item[data-dev]").forEach((n) => {
      n.style.display = isDev ? "" : "none";
    });
    // Notifications (reports + mod-abuse flags) are for full mods + devs only.
    document.querySelectorAll("[data-min2]").forEach((n) => {
      n.style.display = fullMod ? "" : "none";
    });
    if (!isDev && (tab === "mods" || tab === "sessions"))
      switchTab("activity");
    if (!fullMod && tab === "bans") switchTab("activity");
    if (!fullMod && tab === "applications") switchTab("activity");
    renderApplicationsToggle();
    if (!fullMod && tab === "reports") switchTab("activity");
    if (!fullMod && tab === "suggestions") switchTab("activity");
    if (!fullMod && tab === "invites") switchTab("activity");
    if (!fullMod && feedFilter === "notification") {
      feedFilter = "all";
      document
        .querySelectorAll("#filterSeg button")
        .forEach((b) => b.classList.toggle("active", b.dataset.f === "all"));
    }
  }

  // ── Socket wiring ──
  socket.on("connect", () => socket.emit("staff get audit", { limit: 20000 }));

  socket.on("audit snapshot", (data) => {
    authorized = true;
    loadingEl.classList.add("hidden");
    deniedEl.classList.add("hidden");
    appEl.classList.remove("hidden");
    entries = Array.isArray(data && data.entries) ? data.entries : [];
    commentsByRef.clear();
    for (const e of entries)
      if (e.type === "comment" && e.refId) {
        if (!commentsByRef.has(e.refId)) commentsByRef.set(e.refId, []);
        commentsByRef.get(e.refId).push(e);
      }
    me = data && data.me;
    if (me) {
      meEl.textContent = "";
      meEl.appendChild(
        span(
          "chip " + (me.role === "dev" ? "dev" : "mod"),
          (me.role || "staff").toUpperCase(),
        ),
      );
      meEl.appendChild(document.createTextNode(" " + (me.label || "")));
    }
    applyRoleGating();
    renderRoster(data && data.roster);
    renderLegend();
    renderActivity();

    // Populate the left-panel counts immediately, not only when a tab is opened.
    const fullMod = me && (me.role === "dev" || (me.modLevel || 0) >= 2);
    if (me && me.role === "dev") {
      socket.emit("dev list mod keys");
      socket.emit("dev get sessions");
    }
    if (fullMod) {
      socket.emit("dev list blocks");
      socket.emit("staff get ban history");
      socket.emit("mod applications list");
      socket.emit("staff get reports");
      socket.emit("staff get appeals");
      socket.emit("staff get invite report");
    }
  });

  socket.on("audit entry", (e) => {
    if (!e) return;
    entries.push(e);
    if (
      e.type === "notification" &&
      !(tab === "activity" && feedFilter === "notification")
    ) {
      unreadNotifs++;
      updateNotifBadge();
    }
    if (e.type === "comment" && e.refId) {
      if (!commentsByRef.has(e.refId)) commentsByRef.set(e.refId, []);
      commentsByRef.get(e.refId).push(e);
      const card = listEl.querySelector('.entry[data-id="' + e.refId + '"]');
      if (card) appendComment(card, e);
      return;
    }
    // Buffer and flush on a timer so a flood of events can't thrash the DOM.
    pendingNew.push(e);
    scheduleFlush();
  });

  socket.on("dev blocks", (list) => {
    bans = (Array.isArray(list) ? list : []).slice().sort((a, b) => {
      if (a.permanent !== b.permanent) return a.permanent ? -1 : 1;
      return (a.expiry || 0) - (b.expiry || 0);
    });
    renderBans();
  });

  socket.on("staff ban history", (list) => {
    banHistory = Array.isArray(list) ? list : [];
    renderBanHistory();
  });

  socket.on("dev mod keys", (list) => {
    modKeys = Array.isArray(list) ? list : [];
    renderMods();
  });

  socket.on("mod applications", (list) => {
    applicationsList = Array.isArray(list) ? list : [];
    renderApps();
  });

  socket.on("applications state", (d) => {
    applicationsOpen = !d || d.open !== false;
    renderApplicationsToggle();
    renderApps();
  });

  socket.on("staff reports", (list) => {
    reportsList = Array.isArray(list) ? list : [];
    renderReports();
  });

  socket.on("staff appeals", (list) => {
    appealsList = Array.isArray(list) ? list : [];
    renderAppeals();
  });

  socket.on("staff suggestions", (list) => {
    suggestionsList = Array.isArray(list) ? list : [];
    renderSuggestions();
  });

  socket.on("staff invite report", (list) => {
    invitesList = Array.isArray(list) ? list : [];
    invitesPage = 0;
    renderInvites();
  });

  socket.on("staff invite detail", (d) => {
    if (!d || !d.deviceId) return;
    inviteDetails.set(d.deviceId, d);
    // Reflect the post-action state on the list card (counts + verdict change
    // after a purge or undo) without waiting for a full list refresh.
    const idx = invitesList.findIndex((x) => x.deviceId === d.deviceId);
    if (idx >= 0) {
      const c = d.counts || {};
      invitesList[idx] = Object.assign({}, invitesList[idx], {
        pending: c.pending != null ? c.pending : invitesList[idx].pending,
        active: c.active != null ? c.active : invitesList[idx].active,
        distinctIps: d.distinctIps,
        topIpPct: d.topIpPct,
        namedPct: d.namedPct,
        verdict: d.verdict || invitesList[idx].verdict,
      });
    }
    renderInvites();
  });

  socket.on("dev sessions", (data) => {
    sessionData = data || { sessions: [], history: [] };
    renderSessions();
  });

  socket.on("dev mod granted", (d) => {
    if (!d || !d.key || !window.StaffUI) return;
    const w = document.createElement("div");
    const p1 = document.createElement("p");
    p1.textContent =
      "New " +
      (d.level === 1 ? "junior (L1)" : "full (L2)") +
      ' mod key for "' +
      (d.label || "mod") +
      '". Copy it now: it is shown once and never stored.';
    const code = document.createElement("div");
    code.className = "mono";
    code.style.cssText =
      "background:#000;border:1px solid #333;padding:10px;margin:10px 0;word-break:break-all;border-radius:6px;color:#ff9800;";
    code.textContent = d.key;
    w.appendChild(p1);
    w.appendChild(code);
    StaffUI.modal({
      title: "Mod key created",
      icon: '<i class="fas fa-key"></i>',
      body: w,
      actions: [
        {
          label: "Copy key",
          kind: "primary",
          onClick: () => {
            try {
              navigator.clipboard.writeText(d.key);
            } catch (_) {}
          },
        },
        { label: "Done", onClick: () => {} },
      ],
    });
  });

  socket.on("staff action result", (d) => {
    if (d && window.StaffUI)
      StaffUI.toast((d.ok ? "Done: " : "Failed: ") + (d.action || ""), {
        type: d.ok ? "success" : "error",
      });
  });

  const showDenied = () => {
    if (authorized) return;
    loadingEl.classList.add("hidden");
    appEl.classList.add("hidden");
    deniedEl.classList.remove("hidden");
  };
  socket.on("error", showDenied);
  socket.on("connect_error", showDenied);
  setTimeout(showDenied, 4500);

  // ── Key entry (no console) ──
  let pendingStaffKey = null;
  async function openStaffKeyEntry() {
    if (!window.StaffUI) return;
    const key = await StaffUI.prompt({
      title: "Staff access",
      icon: '<i class="fas fa-key"></i>',
      subtitle: "Enter your dev or mod key",
      message: "Verified on the server, then saved to this browser.",
      fields: [
        {
          name: "value",
          label: "Staff key",
          type: "password",
          placeholder: "paste your key",
          required: true,
        },
      ],
      confirmText: "Unlock",
    });
    if (key) {
      pendingStaffKey = key;
      socket.emit("staff validate key", { key });
    }
  }
  socket.on("staff key result", (d) => {
    if (!d || !d.role) {
      if (window.StaffUI)
        StaffUI.toast(
          d && d.throttled
            ? "Too many attempts. Wait a few minutes."
            : "That key was not recognized.",
          { type: "error" },
        );
      pendingStaffKey = null;
      return;
    }
    if (d.role === "dev")
      localStorage.setItem("talkomatic_devKey", pendingStaffKey);
    else localStorage.setItem("talkomatic_modKey", pendingStaffKey);
    pendingStaffKey = null;
    if (window.StaffUI)
      StaffUI.toast("Key accepted. Reloading.", { type: "success" });
    setTimeout(() => window.location.reload(), 1000);
  });

  // ── Controls ──
  $("enterKeyBtn") &&
    $("enterKeyBtn").addEventListener("click", openStaffKeyEntry);
  $("navToggle").addEventListener("click", () =>
    document.body.classList.toggle("nav-closed"),
  );
  $("navBackdrop").addEventListener("click", () =>
    document.body.classList.add("nav-closed"),
  );
  document
    .querySelectorAll(".nav-item")
    .forEach((n) =>
      n.addEventListener("click", () => switchTab(n.dataset.tab)),
    );
  $("bansRefresh").addEventListener("click", () => {
    socket.emit("dev list blocks");
    socket.emit("staff get ban history");
  });
  $("banIpBtn") && $("banIpBtn").addEventListener("click", openBanIpDialog);
  $("modsRefresh").addEventListener("click", () =>
    socket.emit("dev list mod keys"),
  );
  $("sessionsRefresh") &&
    $("sessionsRefresh").addEventListener("click", () =>
      socket.emit("dev get sessions"),
    );
  $("grantMod").addEventListener("click", grantMod);
  $("appsRefresh") &&
    $("appsRefresh").addEventListener("click", () =>
      socket.emit("mod applications list"),
    );
  $("appsToggle") &&
    $("appsToggle").addEventListener("click", () =>
      socket.emit("dev set applications open", { open: !applicationsOpen }),
    );
  $("reportsRefresh") &&
    $("reportsRefresh").addEventListener("click", () =>
      socket.emit("staff get reports"),
    );
  $("appealsRefresh") &&
    $("appealsRefresh").addEventListener("click", () =>
      socket.emit("staff get appeals"),
    );
  $("suggestionsRefresh") &&
    $("suggestionsRefresh").addEventListener("click", () =>
      socket.emit("staff get suggestions"),
    );
  $("invitesRefresh") &&
    $("invitesRefresh").addEventListener("click", () => {
      inviteDetails.clear();
      socket.emit("staff get invite report");
    });

  // Applications: status segment + live search (own debounce, own page reset).
  document.querySelectorAll("#appsSeg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#appsSeg button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      appsFilter = btn.dataset.s || "pending";
      appsPage = 0;
      renderApps();
    });
  });
  let appsSearchDebounce = null;
  $("appsSearch") &&
    $("appsSearch").addEventListener("input", () => {
      clearTimeout(appsSearchDebounce);
      appsSearchDebounce = setTimeout(() => {
        appsQuery = $("appsSearch").value.trim().toLowerCase();
        appsPage = 0;
        renderApps();
      }, 200);
    });

  let searchDebounce = null;
  searchEl.addEventListener("input", () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      query = searchEl.value.trim().toLowerCase();
      renderActivity();
    }, 200);
  });
  document.querySelectorAll("#filterSeg button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll("#filterSeg button")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      feedFilter = btn.dataset.f;
      if (feedFilter === "notification") {
        unreadNotifs = 0;
        updateNotifBadge();
      }
      renderActivity();
    });
  });

  // Open the sidebar by default on wider screens.
  if (window.innerWidth > 860) document.body.classList.remove("nav-closed");

  window.addEventListener("beforeunload", () => {
    try {
      socket.emit("staff stop audit");
    } catch (_) {}
  });
})();
