// public/js/suggest-board.js
// Community suggestion board modal for the lobby. Loads after lobby-client.js
// and reuses its `socket`. Everyone can post/reply/vote; devs get status +
// delete controls. All text is escaped before the markdown-lite formatting is
// applied, so nothing a user types can become live HTML.
(function () {
  "use strict";
  if (typeof socket === "undefined") return;

  var board = null; // last "board data" payload from the server
  var sortMode = "top"; // "top" | "new"
  var expanded = {}; // suggestion id -> replies section open
  var built = false;
  var isOpen = false;
  var knownIds = null; // post ids already seen, so live-arriving ones can flash

  // ── helpers ───────────────────────────────────────────────────────────────

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Markdown-lite: **bold** *italic* ~~strike~~ `code`. Escaped first, so the
  // only HTML that can appear is what this function itself emits.
  function renderRich(text) {
    var s = esc(text);
    s = s.replace(/\*\*([^*\n][^*]*?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/\*([^*\n][^*]*?)\*/g, "<em>$1</em>");
    s = s.replace(/~~([^~\n][^~]*?)~~/g, "<s>$1</s>");
    s = s.replace(/`([^`\n]+?)`/g, "<code>$1</code>");
    s = s.replace(/\n/g, "<br>");
    return s;
  }

  function timeAgo(ts) {
    var d = Date.now() - ts;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.floor(d / 60000) + "m ago";
    if (d < 86400000) return Math.floor(d / 3600000) + "h ago";
    if (d < 30 * 86400000) return Math.floor(d / 86400000) + "d ago";
    return new Date(ts).toLocaleDateString();
  }

  function toast(msg, type) {
    if (window.StaffUI) StaffUI.toast(msg, { type: type || "info" });
  }

  // Role badges come only from the server-stamped role field, never from the
  // display name, so they cannot be impersonated.
  function badgeFor(role) {
    if (role === "dev") {
      var b = el("span", "sb-badge sb-badge-dev");
      var crown = el("img");
      crown.src = "images/icons/crown.gif";
      crown.alt = "";
      b.appendChild(crown);
      b.appendChild(document.createTextNode("DEV"));
      b.title = "Talkomatic developer";
      return b;
    }
    if (role === "mod") {
      var m = el("span", "mod-lobby-badge", "MOD");
      m.title = "Moderator";
      return m;
    }
    if (role === "jr") {
      var j = el("span", "mod-lobby-badge mod-lobby-badge-jr", "JR MOD");
      j.title = "Junior moderator";
      return j;
    }
    return null;
  }

  var STATUS_META = {
    approved: { label: "Approved", cls: "sb-st-approved", icon: "fa-check" },
    implemented: {
      label: "Implemented",
      cls: "sb-st-implemented",
      icon: "fa-rocket",
    },
    declined: { label: "Declined", cls: "sb-st-declined", icon: "fa-xmark" },
  };

  // ── modal skeleton ────────────────────────────────────────────────────────

  var overlay, listWrap, remainChip, composeArea, composeCount, postBtn;
  var previewWrap, previewBody, statsWrap;

  // Discord avatar next to the author, only when that user has the pfp
  // feature enabled. URL is rebuilt from a validated id + hash, like the
  // lobby and room lists do.
  var SB_ID_RE = /^\d{17,20}$/;
  var SB_HASH_RE = /^(?:a_)?[a-f0-9]{32}$/i;

  function discordPfp(av, small) {
    if (!av || !SB_ID_RE.test(av.id || "") || !SB_HASH_RE.test(av.hash || ""))
      return null;
    var img = el("img", "sb-pfp" + (small ? " sb-pfp-sm" : ""));
    img.alt = "";
    img.src =
      "https://cdn.discordapp.com/avatars/" +
      av.id +
      "/" +
      av.hash +
      ".webp?size=64" +
      (av.animated ? "&animated=true" : "");
    img.onerror = function () {
      img.style.display = "none";
    };
    return img;
  }

  function build() {
    if (built) return;
    built = true;

    overlay = el("div", "sb-overlay");
    overlay.id = "suggestBoardOverlay";

    var modal = el("div", "sb-modal");

    // Header
    var head = el("div", "sb-head");
    var title = el("div", "sb-title");
    title.innerHTML = '<i class="fas fa-lightbulb"></i> Suggestion Board';
    var sub = el("div", "sb-sub", "Post ideas, vote, and see what gets built.");
    var titleWrap = el("div", "sb-title-wrap");
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);

    statsWrap = el("div", "sb-stats");

    var sortWrap = el("div", "sb-sort");
    ["top", "new"].forEach(function (mode) {
      var b = el(
        "button",
        "sb-sort-btn" + (sortMode === mode ? " active" : ""),
        mode === "top" ? "Top" : "New",
      );
      b.dataset.mode = mode;
      b.addEventListener("click", function () {
        sortMode = mode;
        sortWrap.querySelectorAll(".sb-sort-btn").forEach(function (x) {
          x.classList.toggle("active", x.dataset.mode === sortMode);
        });
        renderList();
      });
      sortWrap.appendChild(b);
    });

    var closeBtn = el("button", "sb-close", "×");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.addEventListener("click", close);

    head.appendChild(titleWrap);
    head.appendChild(statsWrap);
    head.appendChild(sortWrap);
    head.appendChild(closeBtn);

    // Cream section strip, same look as "Be Known As..." in the lobby
    var composeStrip = el("div", "sb-strip", "Share An Idea...");

    // Composer
    var compose = el("div", "sb-compose");
    var toolbar = el("div", "sb-toolbar");
    [
      ["fa-bold", "**", "Bold"],
      ["fa-italic", "*", "Italic"],
      ["fa-strikethrough", "~~", "Strikethrough"],
      ["fa-code", "`", "Code"],
    ].forEach(function (t) {
      var b = el("button", "sb-tool");
      b.innerHTML = '<i class="fas ' + t[0] + '"></i>';
      b.title = t[2];
      b.type = "button";
      b.addEventListener("click", function () {
        wrapSelection(composeArea, t[1]);
      });
      toolbar.appendChild(b);
    });
    remainChip = el("span", "sb-remain", "");
    toolbar.appendChild(remainChip);

    composeArea = el("textarea", "sb-input");
    composeArea.maxLength = 600;
    composeArea.rows = 4;
    composeArea.placeholder =
      "What should we add or change? (**bold**, *italic*, ~~strike~~, `code`)";
    composeArea.addEventListener("input", updateCount);

    // Live preview of the rendered post, shown while there is text
    previewWrap = el("div", "sb-preview-wrap");
    previewWrap.style.display = "none";
    var previewLabel = el("div", "sb-preview-label");
    previewLabel.innerHTML = '<i class="fas fa-eye"></i> Preview';
    previewBody = el("div", "sb-preview");
    previewWrap.appendChild(previewLabel);
    previewWrap.appendChild(previewBody);

    var composeFoot = el("div", "sb-compose-foot");
    composeCount = el("span", "sb-count", "0 / 600");
    postBtn = el("button", "sb-post-btn");
    postBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Post';
    postBtn.addEventListener("click", submitPost);
    composeFoot.appendChild(composeCount);
    composeFoot.appendChild(postBtn);

    compose.appendChild(toolbar);
    compose.appendChild(composeArea);
    compose.appendChild(previewWrap);
    compose.appendChild(composeFoot);

    // List
    var listStrip = el("div", "sb-strip", "The Board...");
    listWrap = el("div", "sb-list");

    modal.appendChild(head);
    modal.appendChild(composeStrip);
    modal.appendChild(compose);
    modal.appendChild(listStrip);
    modal.appendChild(listWrap);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen) close();
    });

    socket.on("board data", function (data) {
      board = data || null;
      if (isOpen) render();
    });
    socket.on("board result", function (d) {
      if (!d) return;
      if (!d.ok) {
        toast(d.error || "Something went wrong.", "error");
        return;
      }
      if (d.action === "post") {
        composeArea.value = "";
        updateCount();
        toast("Posted! Thanks for the idea.", "success");
      }
    });
  }

  function wrapSelection(ta, marker) {
    var s = ta.selectionStart || 0;
    var e = ta.selectionEnd || 0;
    var v = ta.value;
    var sel = v.slice(s, e) || "text";
    ta.value = v.slice(0, s) + marker + sel + marker + v.slice(e);
    ta.focus();
    ta.selectionStart = s + marker.length;
    ta.selectionEnd = s + marker.length + sel.length;
    updateCount();
  }

  function updateCount() {
    composeCount.textContent = composeArea.value.length + " / 600";
    if (composeArea.value.trim()) {
      previewWrap.style.display = "block";
      previewBody.innerHTML = renderRich(composeArea.value);
    } else {
      previewWrap.style.display = "none";
    }
  }

  function submitPost() {
    var text = composeArea.value.trim();
    if (text.length < 8)
      return toast(
        "Please write a little more (at least 8 characters).",
        "error",
      );
    socket.emit("board post", { text: text });
  }

  // ── rendering ─────────────────────────────────────────────────────────────

  function render() {
    if (!board) return;
    remainChip.textContent =
      board.remaining > 0
        ? board.remaining +
          " post" +
          (board.remaining === 1 ? "" : "s") +
          " left today"
        : "Daily post limit reached";
    remainChip.classList.toggle("sb-remain-empty", board.remaining === 0);
    postBtn.disabled = board.remaining === 0;
    renderStats();
    renderList();
  }

  function renderStats() {
    if (!statsWrap) return;
    statsWrap.textContent = "";
    var posts = (board && board.posts) || [];
    var counts = { approved: 0, implemented: 0 };
    posts.forEach(function (p) {
      if (counts[p.status] !== undefined) counts[p.status]++;
    });
    var chips = [
      ["sb-chip", '<i class="fas fa-lightbulb"></i>', posts.length + " ideas"],
    ];
    if (counts.implemented)
      chips.push([
        "sb-chip sb-chip-impl",
        '<i class="fas fa-rocket"></i>',
        counts.implemented + " Implemented",
      ]);
    if (counts.approved)
      chips.push([
        "sb-chip sb-chip-appr",
        '<i class="fas fa-check"></i>',
        counts.approved + " approved",
      ]);
    chips.forEach(function (c) {
      var chip = el("span", c[0]);
      chip.innerHTML = c[1] + " " + c[2];
      statsWrap.appendChild(chip);
    });
  }

  function sortedPosts() {
    var posts = (board && board.posts ? board.posts : []).slice();
    if (sortMode === "top")
      posts.sort(function (a, b) {
        return b.up - b.down - (a.up - a.down) || b.at - a.at;
      });
    else
      posts.sort(function (a, b) {
        return b.at - a.at;
      });
    return posts;
  }

  function renderList() {
    if (!listWrap) return;
    // Live updates re-render the whole list; keep the reader's place, any
    // half-typed reply, and its focus, so an arriving post never disrupts.
    var scrollTop = listWrap.scrollTop;
    var drafts = {};
    var focusPid = null;
    listWrap.querySelectorAll(".sb-reply-input input").forEach(function (inp) {
      if (inp.value) drafts[inp.dataset.pid] = inp.value;
      if (document.activeElement === inp) focusPid = inp.dataset.pid;
    });

    listWrap.textContent = "";
    var posts = sortedPosts();
    if (!posts.length) {
      var empty = el("div", "sb-empty");
      empty.innerHTML =
        '<i class="fas fa-lightbulb"></i><p>No suggestions yet. Be the first!</p>';
      listWrap.appendChild(empty);
      return;
    }
    posts.forEach(function (p) {
      var card = cardFor(p);
      if (knownIds && !knownIds.has(p.id)) card.classList.add("sb-fresh");
      listWrap.appendChild(card);
    });
    knownIds = new Set(
      posts.map(function (p) {
        return p.id;
      }),
    );

    listWrap.querySelectorAll(".sb-reply-input input").forEach(function (inp) {
      if (drafts[inp.dataset.pid]) inp.value = drafts[inp.dataset.pid];
      if (focusPid && inp.dataset.pid === focusPid) {
        inp.focus();
        inp.selectionStart = inp.selectionEnd = inp.value.length;
      }
    });
    listWrap.scrollTop = scrollTop;
  }

  function cardFor(p) {
    var card = el(
      "div",
      "sb-card" + (p.status !== "open" ? " sb-" + p.status : ""),
    );

    // Vote column
    var votes = el("div", "sb-votes");
    var upBtn = el(
      "button",
      "sb-vote-btn" + (p.myVote === 1 ? " active-up" : ""),
    );
    upBtn.innerHTML = '<i class="fas fa-chevron-up"></i>';
    upBtn.title = "Upvote";
    upBtn.addEventListener("click", function () {
      socket.emit("board vote", { id: p.id, dir: p.myVote === 1 ? 0 : 1 });
    });
    var score = el("div", "sb-score", String(p.up - p.down));
    score.title = p.up + " up / " + p.down + " down";
    if (p.up - p.down > 0) score.classList.add("pos");
    if (p.up - p.down < 0) score.classList.add("neg");
    var downBtn = el(
      "button",
      "sb-vote-btn" + (p.myVote === -1 ? " active-down" : ""),
    );
    downBtn.innerHTML = '<i class="fas fa-chevron-down"></i>';
    downBtn.title = "Downvote";
    downBtn.addEventListener("click", function () {
      socket.emit("board vote", { id: p.id, dir: p.myVote === -1 ? 0 : -1 });
    });
    votes.appendChild(upBtn);
    votes.appendChild(score);
    votes.appendChild(downBtn);

    // Main column
    var main = el("div", "sb-main");

    var meta = el("div", "sb-meta");
    var pfp = discordPfp(p.avatar);
    if (pfp) meta.appendChild(pfp);
    var badge = badgeFor(p.role);
    if (badge) meta.appendChild(badge);
    meta.appendChild(el("span", "sb-name", p.name || "Anonymous"));
    if (p.mine) meta.appendChild(el("span", "sb-mine", "you"));
    meta.appendChild(el("span", "sb-time", timeAgo(p.at)));
    var st = STATUS_META[p.status];
    if (st) {
      var chip = el("span", "sb-status " + st.cls);
      chip.innerHTML = '<i class="fas ' + st.icon + '"></i> ' + st.label;
      if (p.statusBy) chip.title = "Set by " + p.statusBy;
      meta.appendChild(chip);
    }

    var body = el("div", "sb-text");
    body.innerHTML = renderRich(p.text);

    var foot = el("div", "sb-foot");
    var replyToggle = el(
      "button",
      "sb-link",
      p.replyCount
        ? p.replyCount + " " + (p.replyCount === 1 ? "reply" : "replies")
        : "Reply",
    );
    replyToggle.addEventListener("click", function () {
      expanded[p.id] = !expanded[p.id];
      renderList();
    });
    foot.appendChild(replyToggle);

    // Dev-only moderation controls
    if (board.canModerate) {
      var ctl = el("span", "sb-dev-controls");
      [
        ["approved", "Approve"],
        ["implemented", "Implemented"],
        ["declined", "Decline"],
        ["open", "Reopen"],
      ].forEach(function (opt) {
        if (p.status === opt[0]) return;
        var b = el("button", "sb-link sb-dev-link", opt[1]);
        b.addEventListener("click", function () {
          socket.emit("board status", { id: p.id, status: opt[0] });
        });
        ctl.appendChild(b);
      });
      var del = el("button", "sb-link sb-dev-link sb-danger", "Delete");
      del.addEventListener("click", function () {
        var go = function () {
          socket.emit("board delete", { id: p.id });
        };
        if (window.StaffUI)
          StaffUI.confirm({
            title: "Delete suggestion",
            message: "Remove this post and its replies for everyone?",
            danger: true,
            confirmText: "Delete",
          }).then(function (ok) {
            if (ok) go();
          });
        else go();
      });
      ctl.appendChild(del);
      foot.appendChild(ctl);
    }

    main.appendChild(meta);
    main.appendChild(body);
    main.appendChild(foot);

    if (expanded[p.id]) main.appendChild(repliesFor(p));

    card.appendChild(votes);
    card.appendChild(main);
    return card;
  }

  function repliesFor(p) {
    var wrap = el("div", "sb-replies");
    (p.replies || []).forEach(function (r) {
      var row = el("div", "sb-reply");
      var meta = el("div", "sb-meta");
      var rpfp = discordPfp(r.avatar, true);
      if (rpfp) meta.appendChild(rpfp);
      var badge = badgeFor(r.role);
      if (badge) meta.appendChild(badge);
      meta.appendChild(el("span", "sb-name", r.name || "Anonymous"));
      meta.appendChild(el("span", "sb-time", timeAgo(r.at)));
      if (board.canModerate) {
        var del = el("button", "sb-link sb-dev-link sb-danger", "×");
        del.title = "Delete reply";
        del.addEventListener("click", function () {
          socket.emit("board delete", { id: p.id, replyId: r.id });
        });
        meta.appendChild(del);
      }
      var body = el("div", "sb-text sb-reply-text");
      body.innerHTML = renderRich(r.text);
      row.appendChild(meta);
      row.appendChild(body);
      wrap.appendChild(row);
    });

    var inputRow = el("div", "sb-reply-input");
    var input = el("input", "sb-input sb-input-sm");
    input.type = "text";
    input.maxLength = 300;
    input.dataset.pid = String(p.id);
    input.placeholder = "Write a reply…";
    var send = el("button", "sb-reply-send");
    send.innerHTML = '<i class="fas fa-paper-plane"></i>';
    send.title = "Send reply";
    var doSend = function () {
      var text = input.value.trim();
      if (text.length < 2) return;
      socket.emit("board reply", { id: p.id, text: text });
      input.value = "";
    };
    send.addEventListener("click", doSend);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") doSend();
    });
    inputRow.appendChild(input);
    inputRow.appendChild(send);
    wrap.appendChild(inputRow);
    return wrap;
  }

  // ── open / close ──────────────────────────────────────────────────────────

  function open() {
    build();
    isOpen = true;
    overlay.classList.add("show");
    document.body.style.overflow = "hidden";
    socket.emit("board open");
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    overlay.classList.remove("show");
    document.body.style.overflow = "";
    socket.emit("board close");
  }

  window.SuggestBoard = { open: open, close: close };
})();
