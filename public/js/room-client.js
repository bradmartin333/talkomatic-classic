// public/js/room-client.js
// Talkomatic chat room client: real-time diff-based chat, emote system,
// word filter integration, vote-kick UI, link safety, dev mode UI, layout.

// ── 1. CONSTANTS & STATE ────────────────────────────────────────────────────

// Staff mode: pass dev/mod keys from localStorage in socket auth
const socket = io({
  // WebSocket only, matching the server. No long-poll handshake first.
  transports: ["websocket"],
  upgrade: false,
  auth: {
    devKey: localStorage.getItem("talkomatic_devKey") || undefined,
    modKey: localStorage.getItem("talkomatic_modKey") || undefined,
    deviceId:
      (window.TalkomaticIdentity && window.TalkomaticIdentity.deviceId) ||
      undefined,
  },
});

window.socket = socket;
// On a server restart, show an "updating" notice and reconnect in place (the
// reconnect handler below rejoins the room) instead of bouncing to the lobby.
if (window.TalkomaticConnection)
  window.TalkomaticConnection.attach(socket, { rejoinInPlace: true });
// The Desk (staff chat) rides the same socket; it stays dormant for non-staff.
if (window.TalkoDesk) window.TalkoDesk.init(socket);

let currentUsername = "";
let currentLocation = "";
let currentRoomId = "";
let currentUserId = "";
let currentRoomLayout = "horizontal";
// Desktop-only, client-side view override. When set it wins over the room's
// layout for THIS user's screen only; the server is never told, so nobody
// else is affected and incoming room updates never clobber it. Null means
// "follow the room's layout".
let userLayoutPreference = null;
let currentRoomName = "";
let currentRoomCreatedAt = 0;
let lastSentMessage = "";
let chatInput = null;
// Socket protocol this client speaks. Must match CONFIG.VERSIONS.PROTOCOL on
// the server; on a mismatch after a deploy the client reloads once to pick up
// new code. Bump both together only when a message shape changes.
const CLIENT_PROTOCOL = 1;
// Text the user had typed when the socket dropped, captured at reconnect time
// so a server restart (which forgets live buffers) can re-push it on rejoin.
let pendingRestoreText = null;
let talkoboardInstance = null;
let pianoInstance = null;

// Dev mode state
let currentUserIsDev = false;
let currentUserIsVanished = false;
let currentUserIsHidden = false;

// Mod / staff state
let currentUserIsMod = false;
let currentUserModLevel = 0; // 0 = not a mod, 1 = junior, 2 = full
let isSpectating = false;
const isStaff = () => currentUserIsDev || currentUserIsMod;

// The user's own raw (unfiltered) text and whether the display is filtered
let selfRawText = "";
let selfIsFiltered = false;

const devContext = new Map();

const MAX_MESSAGE_LENGTH = 5000;

// Client-side mirror of the server's MIN_USERS_FOR_VOTING, used for UI
// cleanup only; the server remains the authority on votes
const MIN_USERS_FOR_VOTING = 3;

// Last vote state from the server, re-rendered after local DOM changes
let currentVotes = {};

// Last bot-mute vote state from the server, re-rendered after local DOM changes
let currentMuteVotes = {};
let mutedBotIds = new Set();

const ERROR_CODES = {
  VALIDATION_ERROR: "Validation Error",
  SERVER_ERROR: "Server Error",
  UNAUTHORIZED: "Unauthorized",
  NOT_FOUND: "Not Found",
  RATE_LIMITED: "Rate Limited",
  ACCESS_DENIED: "Access Denied",
  BAD_REQUEST: "Bad Request",
  FORBIDDEN: "Forbidden",
  CIRCUIT_OPEN: "Circuit Open",
};

// ── 2. WORD FILTER ──────────────────────────────────────────────────────────

let clientWordFilter = null;
let wordFilterEnabled = false;

function hasEmote(code) {
  return Object.prototype.hasOwnProperty.call(emoteList, code);
}

// Filters text in segments around valid :code: emote tokens so emote codes
// containing filtered substrings still render instead of becoming asterisks.
// Unknown ":notanemote:" tokens are plain text and stay filterable.
function filterTextPreservingEmotes(text) {
  if (!text.includes(":") && !text.includes(";")) {
    return clientWordFilter.filterText(text);
  }

  const regex = /(:([A-Za-z0-9_.-]+):|;([A-Za-z0-9_.-]+);)/g;
  let result = "";
  let lastIndex = 0;
  let foundEmote = false;
  let match;


  while ((match = regex.exec(text)) !== null) {
    const code = match[2] || match[3];
    if (!code || !hasEmote(code)) continue;
    foundEmote = true;
    result += clientWordFilter.filterText(text.slice(lastIndex, match.index));
    result += match[0];
    lastIndex = match.index + match[0].length;
  }

  if (!foundEmote) {
    return clientWordFilter.filterText(text);
  }

  result += clientWordFilter.filterText(text.slice(lastIndex));
  return result;
}

function applyWordFilter(text) {
  if (!wordFilterEnabled || !clientWordFilter || !clientWordFilter.ready) {
    return text;
  }
  return filterTextPreservingEmotes(text);
}

// Anything else on the page that renders somebody else's words goes through
// here, so one toggle covers the whole site instead of each panel deciding on
// its own.
const filterWatchers = new Set();
window.TalkomaticFilter = {
  enabled: () => wordFilterEnabled,
  apply: (text) => applyWordFilter(String(text == null ? "" : text)),
  onChange(fn) {
    if (typeof fn === "function") filterWatchers.add(fn);
    return () => filterWatchers.delete(fn);
  },
};
function notifyFilterWatchers() {
  for (const fn of filterWatchers) {
    try {
      fn(wordFilterEnabled);
    } catch (_) {
      /* one bad listener must not stop the rest */
    }
  }
}

// ── 3. MODAL SYSTEM ─────────────────────────────────────────────────────────

const customModal = document.getElementById("customModal");
const modalTitle = document.getElementById("modalTitle");
const modalMessage = document.getElementById("modalMessage");
const modalInput = document.getElementById("modalInput");
const modalInputContainer = document.getElementById("modalInputContainer");
const modalInputError = document.getElementById("modalInputError");
const modalCancelBtn = document.getElementById("modalCancelBtn");
const modalConfirmBtn = document.getElementById("modalConfirmBtn");
const closeModalBtn = document.querySelector(".close-modal-btn");
let currentModalCallback = null;

function showModal(title, message, options = {}) {
  modalTitle.textContent = title;
  modalMessage.textContent = message;
  modalInputContainer.style.display = "none";
  modalInput.value = "";
  modalInputError.style.display = "none";
  modalInputError.textContent = "";
  if (options.showInput) {
    modalInputContainer.style.display = "block";
    modalInput.placeholder = options.inputPlaceholder || "";
    modalInput.setAttribute("maxlength", options.maxLength || "6");
    modalInput.focus();
  }
  modalCancelBtn.textContent = options.cancelText || "Cancel";
  modalConfirmBtn.textContent = options.confirmText || "Confirm";
  modalCancelBtn.style.display =
    options.showCancel !== false ? "block" : "none";
  currentModalCallback = options.callback || null;
  customModal.classList.add("show");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  customModal.classList.remove("show");
  document.body.style.overflow = "";
  currentModalCallback = null;
}

function showErrorModal(message) {
  showModal("Error", message, { showCancel: false, confirmText: "OK" });
}

function showInfoModal(message, callback = null) {
  showModal("Information", message, {
    showCancel: false,
    confirmText: "OK",
    callback: callback || (() => { }),
  });
}

function showConfirmModal(message, callback) {
  showModal("Confirmation", message, {
    confirmText: "Yes",
    cancelText: "No",
    callback,
  });
}

function showInputModal(title, message, options, callback) {
  showModal(title, message, {
    showInput: true,
    inputPlaceholder: options.placeholder || "",
    maxLength: options.maxLength || "6",
    confirmText: options.confirmText || "Submit",
    callback: (confirmed, inputValue) => {
      if (confirmed && options.validate) {
        const result = options.validate(inputValue);
        if (result !== true) {
          modalInputError.textContent = result;
          modalInputError.style.display = "block";
          return false;
        }
      }
      callback(confirmed, inputValue);
      return true;
    },
  });
}

modalConfirmBtn.addEventListener("click", () => {
  if (currentModalCallback) {
    if (currentModalCallback(true, modalInput.value) !== false) closeModal();
  } else closeModal();
});
modalCancelBtn.addEventListener("click", () => {
  if (currentModalCallback) currentModalCallback(false);
  closeModal();
});
closeModalBtn.addEventListener("click", closeModal);
customModal.addEventListener("click", (e) => {
  if (e.target === customModal) closeModal();
});
modalInput.addEventListener("input", (e) => {
  e.target.value = e.target.value.replace(/[^0-9]/g, "");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && customModal.classList.contains("show"))
    closeModal();
});
modalInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") modalConfirmBtn.click();
});

// ── 4. TAB NOTIFICATIONS ────────────────────────────────────────────────────
// No OS-level toasts here (that needs a permission dialog) — just a small red
// dot drawn onto the tab favicon while you're away, cleared the moment you
// come back. notificationsEnabled is the user's opt-in for all of it.

const notifyToggleButton = document.getElementById("notifyToggle");
const notifyIcon = document.getElementById("notifyIcon");
let notificationsEnabled = true;

const faviconLink = document.querySelector('link[rel="icon"]');
const originalFaviconHref = faviconLink ? faviconLink.href : null;
let tabDotShown = false;

function showTabDot() {
  if (tabDotShown || !faviconLink || !originalFaviconHref) return;
  tabDotShown = true;

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      tabDotShown = false;
      return;
    }
    ctx.drawImage(img, 0, 0);
    const r = img.width * 0.28;
    ctx.beginPath();
    ctx.arc(img.width - r, r, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ff3b30";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = img.width * 0.06;
    ctx.stroke();
    faviconLink.href = canvas.toDataURL("image/png");
  };
  img.onerror = () => {
    tabDotShown = false;
  };
  img.src = originalFaviconHref;
}
function clearTabDot() {
  if (!tabDotShown || !faviconLink) return;
  faviconLink.href = originalFaviconHref;
  tabDotShown = false;
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) clearTabDot();
});

function toggleNotifications() {
  notificationsEnabled = !notificationsEnabled;
  localStorage.setItem("notificationsEnabled", JSON.stringify(notificationsEnabled));
  updateNotifyIcon();
}

// Somebody typed your name in this room. One nudge per person per minute is
// enforced server side, so this can just show it.
socket.on("room mention", (data) => {
  const by = (data && data.by) || "Someone";
  if (window.toastr) toastr.info(by + " mentioned you");
  if (notificationsEnabled) showTabDot();
  // Blink it into the tab title for anyone looking at another window.
  if (document.hidden) {
    const original = document.title;
    document.title = by + " mentioned you";
    const restore = () => {
      document.title = original;
      document.removeEventListener("visibilitychange", restore);
    };
    document.addEventListener("visibilitychange", restore);
  }
});
function updateNotifyIcon() {
  notifyIcon.className = notificationsEnabled ? "fas fa-bell" : "fas fa-bell-slash";
  notifyToggleButton.setAttribute(
    "aria-label",
    notificationsEnabled ? "Notifications On" : "Notifications Off",
  );
}

// ── 5. CONTENTEDITABLE UTILITIES ────────────────────────────────────────────

// Extracts plain text from the contenteditable, converting emote <img>
// elements back to their :code: tokens and DIVs/BRs to newlines
function getPlainText(element) {
  if (!element) return "";
  function extract(node) {
    let t = "";
    if (node.nodeType === Node.TEXT_NODE) {
      t += node.textContent;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      if (node.nodeName === "IMG" && node.dataset.emoteCode) {
        t += node.dataset.emoteOverlay === "true"
          ? `;${node.dataset.emoteCode};`
          : `:${node.dataset.emoteCode}:`;
      } else if (node.nodeName === "BR") {
        t += "\n";
      } else if (node.nodeName === "DIV") {
        if (node.previousSibling) t += "\n";
        // An empty line is represented as <div><br></div>; the "\n" above
        // already accounts for it, so don't also count the placeholder <br>.
        const isEmptyLinePlaceholder =
          node.childNodes.length === 1 && node.firstChild.nodeName === "BR";
        if (!isEmptyLinePlaceholder) {
          for (const child of node.childNodes) t += extract(child);
        }
      } else {
        for (const child of node.childNodes) t += extract(child);
      }
    }
    return t;
  }
  try {
    return extract(element);
  } catch {
    return element.textContent || "";
  }
}

function placeCursorAtEnd(el) {
  if (!el) return;
  try {
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  } catch { }
}

// Returns the caret position as a plain-text offset (emotes count as the
// length of their :code: token)
function getCursorPosition(element) {
  if (!element) return 0;
  try {
    const sel = window.getSelection();
    if (sel.rangeCount === 0) return 0;
    const range = sel.getRangeAt(0);
    const pre = range.cloneRange();
    pre.selectNodeContents(element);
    pre.setEnd(range.endContainer, range.endOffset);
    function countLen(node) {
      let len = 0;
      const w = document.createTreeWalker(
        node,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        null,
        false,
      );
      while (w.nextNode()) {
        if (w.currentNode.nodeType === Node.TEXT_NODE)
          len += w.currentNode.textContent.length;
        else if (
          w.currentNode.nodeName === "IMG" &&
          w.currentNode.dataset.emoteCode
        )
          len += w.currentNode.dataset.emoteCode.length + 2;
      }
      return len;
    }
    return countLen(pre.cloneContents());
  } catch {
    return 0;
  }
}

// Restores the caret to a plain-text offset
function setCursorPosition(element, position) {
  if (!element) return;
  try {
    element.focus();
    const nodes = [];
    const w = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
      null,
      false,
    );
    while (w.nextNode()) nodes.push(w.currentNode);
    if (nodes.length === 0) {
      const r = document.createRange();
      r.setStart(element, 0);
      r.collapse(true);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return;
    }
    let pos = 0;
    for (const node of nodes) {
      let nLen = 0;
      if (node.nodeType === Node.TEXT_NODE) {
        nLen = node.length;
        if (pos + nLen >= position) {
          const r = document.createRange();
          r.setStart(node, position - pos);
          r.collapse(true);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
          return;
        }
      } else if (node.nodeName === "IMG" && node.dataset.emoteCode) {
        nLen = node.dataset.emoteCode.length + 2;
        if (pos + nLen > position) {
          const r = document.createRange();
          r.setStartAfter(node);
          r.collapse(true);
          const s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
          return;
        }
      }
      pos += nLen;
    }
    placeCursorAtEnd(element);
  } catch {
    placeCursorAtEnd(element);
  }
}

// Computes a minimal diff between two strings for the chat update protocol
function getDiff(oldStr, newStr) {
  if (oldStr === newStr) return null;
  if (newStr.startsWith(oldStr))
    return {
      type: "add",
      text: newStr.slice(oldStr.length),
      index: oldStr.length,
    };
  if (oldStr.startsWith(newStr))
    return {
      type: "delete",
      count: oldStr.length - newStr.length,
      index: newStr.length,
    };
  return { type: "full-replace", text: newStr };
}

// ── 6. EMOTE SYSTEM ─────────────────────────────────────────────────────────

let emoteList = {};
let emoteAutocomplete = null;
let autocompleteActive = false;
let selectedEmoteIndex = -1;
let filteredEmotes = [];
let currentEmotePrefix = "";
let currentEmoteInfo = null;
let useOverlayEmotes = false;

async function loadEmotes() {
  const BASE =
    "https://raw.githubusercontent.com/ZackiBoiz/Multiplayer-Piano-Optimizations/refs/heads/main/emotes";
  try {
    // referrerPolicy: no-referrer silences the cross-site referrer warning and
    // sends nothing about our origin. signal: a hard timeout so a slow/hung
    // GitHub never stalls the caller (this runs during room init).
    const resp = await fetch(`${BASE}/meta.jsonc?_=${Date.now()}`, {
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const pairs = parseJSONC(await resp.text());
    const validCode = /^[A-Za-z0-9_.-]+$/;
    const validExt = /^(?:png|gif|webp|jpe?g|avif|heif|tiff|bmp|svg)$/i;
    const next = Object.fromEntries(
      Object.entries(pairs)
        .filter(([name, ext]) =>
          validCode.test(name) &&
          typeof ext === "string" &&
          validExt.test(ext)
        )
        .map(([name, ext]) => [name, `${BASE}/assets/${name}.${ext}`]),
    );
    // Only swap in a non-empty set, so a valid-but-empty response can't blank
    // emotes either.
    if (Object.keys(next).length) emoteList = next;
    console.log("Emotes loaded:", Object.keys(emoteList).length);
  } catch (err) {
    // A transient failure (GitHub blip, timeout, rate-limit, offline) must NOT
    // wipe emotes we already have - keep the last good set instead of dropping
    // every emote to plain text.
    console.error("Error loading emotes:", err);
  }
}

function parseJSONC(input, filteredTags = ["*"]) { // "*" represents unwanted, not wildcard
  const json = stripJSONC(input, filteredTags);
  return JSON.parse(json);
}

function stripJSONC(input, filteredTags = []) {
  const filtered = new Set(
    Array.isArray(filteredTags) ? filteredTags : [filteredTags]
  );

  let out = "";
  let i = 0;

  let inString = false;
  let stringQuote = "";
  let escaped = false;
  let inBlockComment = false;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (ch === "/" && next === "/") {
      const lineStart = out.lastIndexOf("\n") + 1;
      const lineBeforeComment = out.slice(lineStart);
      const trimmed = lineBeforeComment.trimEnd();

      const propMatch = trimmed.match(
        /(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*.*$/
      );

      if (propMatch) {
        const commentText = input.slice(i + 2, input.indexOf("\n", i) === -1 ? input.length : input.indexOf("\n", i));
        const tags = commentText
          .split(";")
          .map(s => s.trim())
          .filter(Boolean);

        if (tags.some(tag => filtered.has(tag))) {
          out = out.slice(0, lineStart);
          while (i < input.length && input[i] !== "\n") i++;
          continue;
        }
      }

      while (i < input.length && input[i] !== "\n") i++;
      continue;
    }

    out += ch;
    i++;
  }

  return removeTrailingCommas(out);
}

function removeTrailingCommas(input) {
  let out = "";
  let i = 0;

  let inString = false;
  let stringQuote = "";
  let escaped = false;

  while (i < input.length) {
    const ch = input[i];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i++;
      continue;
    }

    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;

      if (input[j] === "}" || input[j] === "]") {
        i++;
        continue;
      }
    }

    out += ch;
    i++;
  }

  return out;
}

function createEmoteNode(emoteCode, isOverlay = false) {
  const img = document.createElement("img");
  img.referrerPolicy = "no-referrer";
  img.src = emoteList[emoteCode];
  img.alt = isOverlay ? `;${emoteCode};` : `:${emoteCode}:`;
  // img.title = img.alt;
  img.className = isOverlay ? "emote emote-overlay" : "emote";
  img.dataset.emoteCode = emoteCode;
  if (isOverlay) img.dataset.emoteOverlay = "true";
  else delete img.dataset.emoteOverlay;
  img.decoding = "async";
  return img;
}

function replaceEmotes(element) {
  if (!element) return;
  const text = getPlainText(element);
  if (!text.includes(":") && !text.includes(";")) return;

  const tokenRegex = /(:([A-Za-z0-9_.-]+):|;([A-Za-z0-9_.-]+);)/g;
  const matches = [...text.matchAll(tokenRegex)];
  if (matches.length === 0) return;

  const isActive = document.activeElement === element;
  const cursorPos = isActive ? getCursorPosition(element) : 0;
  const frag = document.createDocumentFragment();
  let lastIndex = 0;
  let changed = false;

  const appendText = (value) => {
    if (value) frag.appendChild(document.createTextNode(value));
  };

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const tokenStart = match.index ?? 0;
    const tokenEnd = tokenStart + match[0].length;

    appendText(text.slice(lastIndex, tokenStart));

    const normalCode = match[2];
    const overlayCode = match[3];
    const code = normalCode || overlayCode;

    if (!code || !hasEmote(code)) {
      appendText(match[0]);
      lastIndex = tokenEnd;
      continue;
    }

    if (normalCode) {
      const stack = [{ code, isOverlay: false }];
      let consumedEnd = tokenEnd;
      let j = i + 1;

      while (j < matches.length) {
        const next = matches[j];
        const nextStart = next.index ?? consumedEnd;
        const between = text.slice(consumedEnd, nextStart);

        if (!/^\s*$/.test(between)) break;
        if (!next[3] || !hasEmote(next[3])) break;

        stack.push({ code: next[3], isOverlay: true });
        consumedEnd = nextStart + next[0].length;
        j++;
      }

      const stackWrap = document.createElement("span");
      stackWrap.className = "emote-stack";
      stackWrap.title = stack
        .map((token) => (token.isOverlay ? `;${token.code};` : `:${token.code}:`))
        .join(" ");
      stack.forEach((token, idx) => {
        const img = createEmoteNode(token.code, token.isOverlay);
        img.style.zIndex = String(idx + 1);
        stackWrap.appendChild(img);
      });
      frag.appendChild(stackWrap);
      changed = true;
      lastIndex = consumedEnd;
      i = j - 1;
      continue;
    }

    const stackWrap = document.createElement("span");
    stackWrap.className = "emote-stack";
    stackWrap.title = `;${code};`;
    stackWrap.appendChild(createEmoteNode(code, false));
    frag.appendChild(stackWrap);
    changed = true;
    lastIndex = tokenEnd;
  }

  appendText(text.slice(lastIndex));

  if (!changed) return;

  element.innerHTML = "";
  element.appendChild(frag);
  if (isActive) {
    try {
      setCursorPosition(element, cursorPos);
    } catch {
      placeCursorAtEnd(element);
    }
  }
}

// Finds the ":prefix" being typed at the caret. Handles element-node caret
// positions (where the caret lands right after an emote <img> insertion) by
// stepping into the text node immediately before the caret.
function findEmoteAtCursor() {
  if (!chatInput || document.activeElement !== chatInput) return null;
  const sel = window.getSelection();
  if (sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);

  let node = range.startContainer;
  let offset = range.startOffset;

  if (node.nodeType === Node.ELEMENT_NODE) {
    const prev = node.childNodes[offset - 1];
    if (prev && prev.nodeType === Node.TEXT_NODE) {
      node = prev;
      offset = prev.textContent.length;
    } else {
      return null; // caret sits after an <img>/<br>, nothing to complete
    }
  }

  if (node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent;
  let start = offset - 1;
  while (start >= 0 && text[start] !== ":" && text[start] !== ";") start--;
  if (start >= 0 && (text[start] === ":" || text[start] === ";")) {
    const delimiter = text[start];
    const prefix = text.substring(start + 1, offset);
    if (prefix) {
      return {
        node,
        prefix,
        delimiter,
        isOverlayQuery: delimiter === ";",
        startPos: start,
        endPos: offset,
      };
    }
  }
  return null;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findSubsequencePositions(source, query) {
  const positions = [];
  let startIndex = 0;

  for (const ch of query) {
    const idx = source.indexOf(ch, startIndex);
    if (idx === -1) return null;
    positions.push(idx);
    startIndex = idx + 1;
  }

  return positions;
}

function buildHighlightedText(text, positions, contiguousStart = null, contiguousEnd = null) {
  if (!positions || positions.length === 0) return escapeHtml(text);

  let out = "";
  const posSet = new Set(positions);

  for (let i = 0; i < text.length; i++) {
    const ch = escapeHtml(text[i]);
    if (contiguousStart !== null && contiguousEnd !== null) { // cleaner highlighting than a <strong> on every char
      if (i === contiguousStart) out += "<strong style='color: #ff9800'>";
      out += ch;
      if (i === contiguousEnd - 1) out += "</strong>";
      continue;
    }

    if (posSet.has(i)) out += `<strong style='color: #ff9800'>${ch}</strong>`;
    else out += ch;
  }

  return out;
}

function getEmoteAutocompleteMatches(prefix) {
  const q = prefix.toLowerCase();
  const results = [];

  for (const code of Object.keys(emoteList)) {
    const lower = code.toLowerCase();

    if (lower === q) {
      results.push({
        code,
        bucket: 0,
        html: buildHighlightedText(code, [0], 0, q.length),
      });
      continue;
    }

    const substringPos = lower.indexOf(q);
    if (substringPos !== -1) {
      const positions = Array.from({ length: q.length }, (_, i) => substringPos + i);
      results.push({
        code,
        bucket: 1,
        html: buildHighlightedText(code, positions, substringPos, substringPos + q.length),
      });
      continue;
    }

    const subsequencePositions = findSubsequencePositions(lower, q);
    if (subsequencePositions) {
      results.push({
        code,
        bucket: 2,
        html: buildHighlightedText(code, subsequencePositions),
      });
    }
  }

  results.sort((a, b) => { // sorting by buckets
    return a.bucket - b.bucket ||
      a.code.length - b.code.length ||
      a.code.localeCompare(b.code)
  });

  return results;
}

function showAutocomplete(prefix) {
  if (!prefix || prefix.length < 1) {
    hideAutocomplete();
    return;
  }

  const matches = getEmoteAutocompleteMatches(prefix);
  if (matches.length === 0) {
    hideAutocomplete();
    return;
  }

  filteredEmotes = matches;
  currentEmoteInfo = findEmoteAtCursor();

  if (!emoteAutocomplete) {
    emoteAutocomplete = document.getElementById("emoteAutocomplete");
    if (!emoteAutocomplete) {
      emoteAutocomplete = document.createElement("div");
      emoteAutocomplete.id = "emoteAutocomplete";
      emoteAutocomplete.className = "emote-autocomplete";
      document.body.appendChild(emoteAutocomplete);
    }
  }

  const sel = window.getSelection();
  if (sel.rangeCount === 0) {
    hideAutocomplete();
    return;
  }
  const rect = sel.getRangeAt(0).getBoundingClientRect();

  emoteAutocomplete.innerHTML = "";
  const header = document.createElement("div");
  header.className = "emote-autocomplete-header";
  header.textContent = "Emoticons";
  emoteAutocomplete.appendChild(header);

  const list = document.createElement("div");
  list.className = "emote-autocomplete-list";

  filteredEmotes.forEach((match, i) => {
    const item = document.createElement("div");
    item.className =
      "emote-autocomplete-item" + (i === selectedEmoteIndex ? " selected" : "");

    const img = document.createElement("img");
    img.referrerPolicy = "no-referrer";
    img.src = EMOTE_IMAGE_PLACEHOLDER;
    img.dataset.src = emoteList[match.code];
    img.alt = `:${match.code}:`;
    img.decoding = "async";

    const span = document.createElement("span");
    span.innerHTML = match.html;
    span.style.fontFamily = "monospace";

    item.appendChild(img);
    item.appendChild(span);
    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const info = currentEmoteInfo ? { ...currentEmoteInfo } : null;
      setTimeout(() => insertEmote(match.code, info), 0);
    });
    item.addEventListener("mouseover", () => {
      selectedEmoteIndex = i;
      updateSelectedEmote();
    });
    list.appendChild(item);
  });

  const loadVisibleImages = () => hydrateVisibleEmoteImages(list);
  list.addEventListener("scroll", loadVisibleImages, { passive: true });

  emoteAutocomplete.appendChild(list);
  emoteAutocomplete.style.top = `${rect.bottom + window.scrollY + 5}px`;
  emoteAutocomplete.style.left = `${rect.left + window.scrollX}px`;
  emoteAutocomplete.style.display = "block";
  autocompleteActive = true;
  currentEmotePrefix = prefix;
  selectedEmoteIndex = 0;
  updateSelectedEmote();
  requestAnimationFrame(loadVisibleImages);
}

function hideAutocomplete() {
  if (emoteAutocomplete) emoteAutocomplete.style.display = "none";
  autocompleteActive = false;
  selectedEmoteIndex = -1;
  currentEmotePrefix = "";
}

function handleEmoteNavigation(e) {
  if (!autocompleteActive) return false;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      selectedEmoteIndex = (selectedEmoteIndex + 1) % filteredEmotes.length;
      updateSelectedEmote();
      return true;
    case "ArrowUp":
      e.preventDefault();
      selectedEmoteIndex =
        selectedEmoteIndex <= 0
          ? filteredEmotes.length - 1
          : selectedEmoteIndex - 1;
      updateSelectedEmote();
      return true;
    case "Tab":
    case "Enter":
      e.preventDefault();
      if (selectedEmoteIndex < 0 && filteredEmotes.length > 0)
        selectedEmoteIndex = 0;
      if (
        selectedEmoteIndex >= 0 &&
        selectedEmoteIndex < filteredEmotes.length
      ) {
        insertEmote(filteredEmotes[selectedEmoteIndex].code, currentEmoteInfo);
        return true;
      }
      break;
    case "Escape":
      hideAutocomplete();
      return true;
  }
  return false;
}

function updateSelectedEmote() {
  if (!emoteAutocomplete) return;
  emoteAutocomplete
    .querySelectorAll(".emote-autocomplete-item")
    .forEach((item, i) => {
      item.classList.toggle("selected", i === selectedEmoteIndex);
      if (i === selectedEmoteIndex) item.scrollIntoView?.({ block: "nearest" });
    });
}

// Guarantees the caret lives inside a TEXT node after an insertHTML, so the
// next ":" the user types is found by findEmoteAtCursor(). Empty text nodes
// are invisible and ignored by getPlainText().
function ensureCaretInTextNode() {
  try {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType === Node.TEXT_NODE) return;

    const tn = document.createTextNode("");
    range.insertNode(tn);
    range.setStart(tn, 0);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  } catch {
    // non-fatal: autocomplete will simply skip this position
  }
}

function getLastDescendant(node) {
  let cur = node;
  while (cur && cur.lastChild) cur = cur.lastChild;
  return cur;
}

function getFirstDescendant(node) {
  let cur = node;
  while (cur && cur.firstChild) cur = cur.firstChild;
  return cur;
}

function previousDomNode(node) {
  if (!node || !node.parentNode) return null;
  if (node.previousSibling) return getLastDescendant(node.previousSibling);
  return previousDomNode(node.parentNode);
}

function nextDomNode(node) {
  if (!node || !node.parentNode) return null;
  if (node.nextSibling) return getFirstDescendant(node.nextSibling);
  return nextDomNode(node.parentNode);
}

function getEmoteDeletionTarget(node) {
  if (!node) return null;
  if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains("emote-stack")) {
    return node;
  }
  if (node.nodeName === "IMG" && node.dataset.emoteCode) {
    return node.closest?.(".emote-stack") || node;
  }
  return null;
}

function deleteEmoteNodeAtCaret(direction) {
  if (!chatInput) return false;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;

  const range = sel.getRangeAt(0);
  if (!range.collapsed) return false;

  let candidate = null;
  const container = range.startContainer;
  const offset = range.startOffset;

  if (container.nodeType === Node.TEXT_NODE) {
    if (direction === "backward") {
      if (offset !== 0) return false;
      candidate = previousDomNode(container);
    } else {
      if (offset !== (container.textContent || "").length) return false;
      candidate = nextDomNode(container);
    }
  } else if (container.nodeType === Node.ELEMENT_NODE) {
    if (direction === "backward") {
      if (offset > 0) candidate = getLastDescendant(container.childNodes[offset - 1]);
      else candidate = previousDomNode(container);
    } else {
      if (offset < container.childNodes.length) candidate = getFirstDescendant(container.childNodes[offset]);
      else candidate = nextDomNode(container);
    }
  }

  candidate = getEmoteDeletionTarget(candidate);
  if (!candidate || !candidate.parentNode) return false;

  const parent = candidate.parentNode;
  const replacement = document.createTextNode("");
  parent.insertBefore(replacement, candidate);
  candidate.remove();

  try {
    const newRange = document.createRange();
    newRange.setStart(replacement, 0);
    newRange.collapse(true);
    sel.removeAllRanges();
    sel.addRange(newRange);
    ensureCaretInTextNode();
  } catch { }

  return true;
}

function isValidEmoteInfo(info) {
  return !!(
    info &&
    info.node &&
    info.node.isConnected &&
    chatInput &&
    chatInput.contains(info.node)
  );
}

function insertEmote(emoteCode, emoteInfo, options = {}) {
  if (!chatInput) return;
  chatInput.focus();

  const targetInfo = isValidEmoteInfo(emoteInfo)
    ? emoteInfo
    : findEmoteAtCursor();
  const useOverlayToken = options.overlay ?? (targetInfo?.isOverlayQuery ?? false);
  const tokenText = useOverlayToken ? `;${emoteCode};` : `:${emoteCode}:`;

  try {
    if (targetInfo && targetInfo.node && targetInfo.node.parentNode) {
      const sel = window.getSelection();
      const r = document.createRange();
      r.setStart(targetInfo.node, targetInfo.startPos);
      r.setEnd(targetInfo.node, targetInfo.endPos);
      sel.removeAllRanges();
      sel.addRange(r);
    }

    if (useOverlayToken) {
      document.execCommand("insertText", false, tokenText);
      replaceEmotes(chatInput);
    } else {
      const html = `<img src="${emoteList[emoteCode]}" referrerpolicy="no-referrer" alt=":${emoteCode}:" title=":${emoteCode}:" class="emote" data-emote-code="${emoteCode}">`;
      document.execCommand("insertHTML", false, html);
    }
  } catch {
    try {
      document.execCommand(
        useOverlayToken ? "insertText" : "insertHTML",
        false,
        useOverlayToken
          ? tokenText
          : `<img src="${emoteList[emoteCode]}" referrerpolicy="no-referrer" alt=":${emoteCode}:" title=":${emoteCode}:" class="emote" data-emote-code="${emoteCode}">`,
      );
      if (useOverlayToken) replaceEmotes(chatInput);
    } catch { }
  }

  ensureCaretInTextNode();

  hideAutocomplete();
  currentEmoteInfo = null;
  updateSentMessage();
  setTimeout(() => {
    chatInput.focus();
    ensureCaretInTextNode();
  }, 10);
}

// Invite links only credit referrers for people NEW to Talkomatic, so sharing
// them between users already in a room is pointless and farmable. Detect one in
// the input, strip the ref code, and warn the sender.
function hasRefLink(text) {
  return /[?&]ref=[A-Za-z0-9_-]+/i.test(text);
}
function stripRefLinks(text) {
  return text
    .replace(/\?ref=[A-Za-z0-9_-]+(?:&([^\s]*))?/gi, (_m, rest) =>
      rest ? "?" + rest : "",
    )
    .replace(/&ref=[A-Za-z0-9_-]+/gi, "");
}
let lastRefWarnAt = 0;
function warnRefLink() {
  const now = Date.now();
  if (now - lastRefWarnAt < 8000) return;
  lastRefWarnAt = now;
  notify(
    "Invite links only count for people new to Talkomatic. Everyone here is already on it, so the referral code was removed.",
    "warning",
    {
      title: "Invite links don't work in rooms",
      fullWidth: true,
      timeout: 9000,
    },
  );
}
// Re-render the chat box from selfRawText, e.g. after stripping a ref code.
function renderChatInputFromRaw() {
  if (!chatInput) return;
  const display =
    wordFilterEnabled && clientWordFilter?.ready
      ? applyWordFilter(selfRawText)
      : selfRawText;
  chatInput.innerHTML = "";
  chatInput.textContent = display;
  replaceEmotes(chatInput);
  placeCursorAtEnd(chatInput);
}

// Reads the input, reconstructs the raw text if the display is filtered,
// and sends a diff to the server
function updateSentMessage() {
  if (!chatInput) return;
  try {
    const currentDisplay = getPlainText(chatInput);

    if (selfIsFiltered && wordFilterEnabled && clientWordFilter?.ready) {
      const prevDisplay = applyWordFilter(selfRawText);
      selfRawText = reconstructRawText(
        prevDisplay,
        currentDisplay,
        selfRawText,
      );
    } else {
      selfRawText = currentDisplay;
    }

    // Neutralize any invite link before it is sent or shown to others.
    if (hasRefLink(selfRawText)) {
      selfRawText = stripRefLinks(selfRawText);
      renderChatInputFromRaw();
      warnRefLink();
    }

    const diff = getDiff(lastSentMessage, selfRawText);
    if (diff) {
      socket.emit("chat update", { diff, index: diff.index });
      lastSentMessage = selfRawText;
    }

    applySelfFilter();
  } catch (err) {
    console.error("updateSentMessage error:", err);
  }
}

// Maps an edit made on the FILTERED display back onto the RAW text by
// finding the common prefix/suffix and splicing the inserted region
function reconstructRawText(prevFiltered, currentDisplay, prevRaw) {
  if (prevFiltered === currentDisplay) return prevRaw;

  let start = 0;
  while (
    start < prevFiltered.length &&
    start < currentDisplay.length &&
    prevFiltered[start] === currentDisplay[start]
  ) {
    start++;
  }

  let prevEnd = prevFiltered.length - 1;
  let curEnd = currentDisplay.length - 1;
  while (
    prevEnd > start &&
    curEnd > start &&
    prevFiltered[prevEnd] === currentDisplay[curEnd]
  ) {
    prevEnd--;
    curEnd--;
  }

  const inserted = currentDisplay.slice(start, curEnd + 1);
  return prevRaw.slice(0, start) + inserted + prevRaw.slice(prevEnd + 1);
}

// Re-renders the user's own input with the filter applied
function applySelfFilter() {
  if (!chatInput) return;

  if (wordFilterEnabled && clientWordFilter?.ready) {
    const filtered = applyWordFilter(selfRawText);
    const currentDisplay = getPlainText(chatInput);

    if (filtered !== currentDisplay) {
      const cursor = getCursorPosition(chatInput);
      chatInput.innerHTML = "";
      chatInput.textContent = filtered;
      replaceEmotes(chatInput);
      try {
        setCursorPosition(chatInput, cursor);
      } catch {
        placeCursorAtEnd(chatInput);
      }
    }
    selfIsFiltered = true;
  } else {
    selfIsFiltered = false;
  }
}


const EMOTE_IMAGE_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA="; // blank

function isEmoteImageVisible(img, container) {
  if (!img || !container) return false;
  const itemRect = img.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  return (
    itemRect.bottom > containerRect.top &&
    itemRect.top < containerRect.bottom + containerRect.height && // be lenient and lazy-load emotes that are just out of reach (seamless)
    itemRect.right > containerRect.left &&
    itemRect.left < containerRect.right
  );
}

function hydrateVisibleEmoteImages(dropdown) {
  if (!dropdown) return;
  const images = dropdown.querySelectorAll("img[data-src]");
  images.forEach((img) => {
    if (!isEmoteImageVisible(img, dropdown)) return;
    const src = img.dataset.src;
    if (!src) return;
    img.src = src;
    img.removeAttribute("data-src");
  });
}

// Builds the Emoticons button beside .room-type (wrapped in a group so the
// room type display is never replaced) and the emote picker dropdown
// ── 7. APP DIRECTORY ────────────────────────────────────────────────────────

const APPS_DATA = {
  infiniteboard: {
    name: "Talkoboard",
    description: "Draw together in real-time",
    icon: "\uD83C\uDFA8",
    iconClass: "placeholder",
    status: "available",
    url: null,
    openInNewTab: false,
    action: "talkoboard",
  },
  piano: {
    name: "Multiplayer Piano",
    description: "Play piano together in real-time",
    icon: "🎹",
    iconClass: "placeholder",
    status: "available",
    url: null,
    openInNewTab: false,
    action: "piano",
  },
};
let appDirectoryDropdown = null;

function createAppDirectoryDropdown() {
  if (appDirectoryDropdown) appDirectoryDropdown.remove();
  appDirectoryDropdown = document.createElement("div");
  appDirectoryDropdown.className = "app-directory-dropdown";
  appDirectoryDropdown.id = "appDirectoryDropdown";
  const header = document.createElement("div");
  header.className = "app-directory-header";
  header.textContent = "\uD83D\uDE80 App Directory";
  const grid = document.createElement("div");
  grid.className = "app-grid";
  Object.entries(APPS_DATA).forEach(([id, app]) => {
    const item = document.createElement("div");
    item.className = `app-item ${app.status === "coming-soon" ? "disabled" : ""}`;
    const icon = document.createElement("div");
    icon.className = `app-icon ${app.iconClass}`;
    if (app.iconClass === "placeholder") {
      icon.textContent = app.icon;
    } else {
      const img = document.createElement("img");
      img.src = app.icon;
      img.alt = app.name;
      img.style.cssText = "width:100%;height:100%;object-fit:cover";
      icon.appendChild(img);
    }
    const info = document.createElement("div");
    info.className = "app-info";
    const nameEl = document.createElement("div");
    nameEl.className = "app-name";
    nameEl.textContent = app.name;
    const desc = document.createElement("div");
    desc.className = "app-description";
    desc.textContent = app.description;
    info.appendChild(nameEl);
    info.appendChild(desc);
    item.appendChild(icon);
    item.appendChild(info);
    if (app.status === "available") {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideAppDirectory();
        if (app.action === "talkoboard") {
          openTalkoboard();
        } else if (app.action === "piano") {
          openPiano();
        } else if (app.openInNewTab) {
          window.open(app.url, "_blank", "noopener,noreferrer");
        } else {
          window.location.href = app.url;
        }
      });
    }
    grid.appendChild(item);
  });
  appDirectoryDropdown.appendChild(header);
  appDirectoryDropdown.appendChild(grid);
  const navbar = document.querySelector(".top-navbar");
  if (navbar) {
    navbar.style.position = "relative";
    navbar.appendChild(appDirectoryDropdown);
  }
}

function showAppDirectory() {
  if (!appDirectoryDropdown) createAppDirectoryDropdown();
  hideAutocomplete();
  const ed = document.getElementById("emotesDropdown");
  if (ed) ed.style.display = "none";
  appDirectoryDropdown.classList.add("show");
}
function hideAppDirectory() {
  if (appDirectoryDropdown) appDirectoryDropdown.classList.remove("show");
}
function toggleAppDirectory() {
  if (!appDirectoryDropdown) createAppDirectoryDropdown();
  appDirectoryDropdown.classList.contains("show")
    ? hideAppDirectory()
    : showAppDirectory();
}
function initializeAppDirectory() {
  const btn = document.getElementById("appDirectoryToggle");
  if (btn)
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleAppDirectory();
    });
  document.addEventListener("click", (e) => {
    if (
      appDirectoryDropdown?.classList.contains("show") &&
      !appDirectoryDropdown.contains(e.target) &&
      !e.target.closest("#appDirectoryToggle")
    )
      hideAppDirectory();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && appDirectoryDropdown?.classList.contains("show"))
      hideAppDirectory();
  });
}

// ── 8. TALKOBOARD INTEGRATION ───────────────────────────────────────────────

function openTalkoboard() {
  if (!currentRoomId || !currentUserId) {
    showErrorModal("You must be in a room to use Talkoboard.");
    return;
  }
  if (!talkoboardInstance) {
    talkoboardInstance = new Talkoboard(socket, currentUserId, currentUsername, {
      isDev: currentUserIsDev,
      isMod: currentUserIsMod,
    });
  }
  talkoboardInstance.open();
}

function openPiano() {
  if (!currentRoomId || !currentUserId) {
    showErrorModal("You must be in a room to use the Piano.");
    return;
  }
  // If a cached page loaded before piano-client.js shipped, the class is
  // missing - tell the user to refresh instead of silently doing nothing.
  if (typeof Piano === "undefined") {
    showErrorModal(
      "The Piano is still loading. Please refresh the page and try again.",
    );
    return;
  }
  try {
    if (!pianoInstance) {
      pianoInstance = new Piano(socket, currentUserId, currentUsername, {
        isDev: currentUserIsDev,
        isMod: currentUserIsMod,
      });
    }
    pianoInstance.open();
  } catch (err) {
    console.error("Piano failed to open:", err);
    showErrorModal(
      "Sorry, the Piano failed to open. Please refresh the page and try again.",
    );
  }
}

// ── 9. VOTING UI ────────────────────────────────────────────────────────────

// Renders vote counters and button states. Below MIN_USERS_FOR_VOTING all
// counters are removed and highlights cleared (matching server behavior).
// Counters at 0 votes are removed instead of lingering.
function updateVotesUI(votes) {
  currentVotes = votes || {};
  const rows = document.querySelectorAll(".chat-row");
  const votingActive = rows.length >= MIN_USERS_FOR_VOTING;

  rows.forEach((row) => {
    const uid = row.dataset.userId;
    const voteBtn = row.querySelector(".vote-button");
    const count = votingActive
      ? Object.values(currentVotes).filter((v) => v === uid).length
      : 0;

    // Own row: the votes-against-me counter. Click it to see who voted against
    // you (the server already sends the voter->target map; we just surface it).
    if (uid === currentUserId) {
      let counter = row.querySelector(".votes-counter");
      if (!votingActive || count === 0) {
        if (counter) counter.remove();
        closeDislikersPopover();
      } else {
        if (!counter) {
          counter = document.createElement("div");
          counter.className = "votes-counter";
          row.querySelector(".user-info").appendChild(counter);
        }
        counter.textContent = `\uD83D\uDC4E ${count}`;
        counter.style.color = "#ff6b6b";
        counter.style.cursor = "pointer";
        counter.title = "Click to see who disliked you";
        counter.onclick = (e) => {
          e.stopPropagation();
          if (document.getElementById("dislikersPopover")) {
            closeDislikersPopover();
          } else {
            showDislikersPopover(counter, dislikerNames());
          }
        };
        // Keep an open popover in sync as the tally changes.
        if (document.getElementById("dislikersPopover"))
          showDislikersPopover(counter, dislikerNames());
      }
    }

    // Other rows: the vote button
    if (voteBtn) {
      voteBtn.innerHTML = `\uD83D\uDC4E ${count}`;
      voteBtn.classList.toggle(
        "voted",
        votingActive && currentVotes[currentUserId] === uid,
      );
    }
  });
}

// ── Who disliked you ────────────────────────────────────────────────────────
// The server already sends the full voter->target map (filtered for visibility);
// the client just surfaces it. Resolve the people who voted against you to their
// display names. Anyone who has since left (or is hidden from you) falls back to
// a generic label.
function dislikerNames() {
  const nameById = {};
  document.querySelectorAll(".chat-row").forEach((row) => {
    nameById[row.dataset.userId] = row.dataset.username || "";
  });
  const names = [];
  for (const [voterId, targetId] of Object.entries(currentVotes || {})) {
    if (targetId !== currentUserId || voterId === currentUserId) continue;
    names.push(nameById[voterId] || "Someone");
  }
  return names;
}

function onDislikersOutsideClick(e) {
  const pop = document.getElementById("dislikersPopover");
  if (!pop) return;
  if (pop.contains(e.target) || e.target.closest(".votes-counter")) return;
  closeDislikersPopover();
}

function closeDislikersPopover() {
  const existing = document.getElementById("dislikersPopover");
  if (existing) existing.remove();
  document.removeEventListener("click", onDislikersOutsideClick, true);
}

function showDislikersPopover(anchorEl, names) {
  closeDislikersPopover();
  if (!anchorEl || !names.length) return;

  const pop = document.createElement("div");
  pop.id = "dislikersPopover";
  pop.className = "votes-dropdown";

  const title = document.createElement("div");
  title.className = "votes-dropdown-title";
  title.textContent =
    names.length === 1
      ? "1 person disliked you"
      : `${names.length} people disliked you`;
  pop.appendChild(title);

  names.forEach((n) => {
    const item = document.createElement("div");
    item.className = "votes-dropdown-item";
    item.textContent = n;
    pop.appendChild(item);
  });

  // Fixed position next to the counter so the room layout's overflow can't clip
  // it, and so it stays put if rows reflow underneath.
  document.body.appendChild(pop);
  const r = anchorEl.getBoundingClientRect();
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let top = r.bottom + 4;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
  let left = r.left;
  if (left + pw > window.innerWidth - 8)
    left = Math.max(8, window.innerWidth - pw - 8);
  pop.style.top = top + "px";
  pop.style.left = left + "px";

  // Defer so the opening click doesn't immediately count as an outside click.
  setTimeout(
    () => document.addEventListener("click", onDislikersOutsideClick, true),
    0,
  );
}

function adjustVoteButtonVisibility() {
  const userCount = document.querySelectorAll(".chat-row").length;
  document.querySelectorAll(".chat-row").forEach((row) => {
    const btn = row.querySelector(".vote-button");
    if (!btn) return;
    // Staff are immune to vote-kick (the server ignores votes against them).
    // Only hide the button for VISIBLY staff users; hiding it for hidden
    // staff would reveal them, so theirs stays (the vote just does nothing).
    const isVisibleStaff =
      row.classList.contains("dev-user") || !!row.querySelector(".mod-badge");
    btn.style.display =
      userCount >= MIN_USERS_FOR_VOTING &&
        row.dataset.userId !== currentUserId &&
        !isVisibleStaff
        ? "inline-block"
        : "none";
  });
}

// Renders the "vote to mute a bot" status label + button state on bot rows.
// Mirrors updateVotesUI: the server is the sole authority on the tally and
// on whether the mute is currently enforced.
function updateMuteVotesUI(data) {
  currentMuteVotes = data?.muteVotes || {};
  mutedBotIds = new Set(data?.mutedBotIds || []);

  document.querySelectorAll(".chat-row").forEach((row) => {
    const uid = row.dataset.userId;
    const label = row.querySelector(".mute-status-label");
    if (!label) return; // not a bot row

    const votesFor = Object.values(currentMuteVotes).filter(
      (v) => v === uid,
    ).length;
    const isMuted = mutedBotIds.has(uid);

    label.textContent = isMuted
      ? "Muted"
      : votesFor > 0
        ? `${votesFor} vote${votesFor === 1 ? "" : "s"} to mute`
        : "Not muted";
    label.classList.toggle("muted", isMuted);
    row.classList.toggle("bot-muted", isMuted);

    const btn = row.querySelector(".vote-mute-button");
    if (btn) btn.classList.toggle("voted", currentMuteVotes[currentUserId] === uid);

    // Defense-in-depth: the server also pushes an empty "chat update" for a
    // freshly-muted bot, but blank it locally too in case that hasn't landed yet.
    if (isMuted) {
      const ci = row.querySelector(".chat-input");
      if (ci) ci.textContent = "";
    }
  });

  // The "bot-muted" class alone won't stick: adjustLayout() sets inline
  // width/height on every row on its own schedule, which would otherwise
  // overwrite a fresh collapse/expand until the next unrelated resize.
  adjustLayout();
}

// ── 10. CHAT PROCESSING ─────────────────────────────────────────────────────

// Extended chat indicator: tracks, per other-user box, whether this viewer is
// currently "following" the bottom of that box (auto-scrolls on every text
// update) or has scrolled away to read earlier text (auto-scroll pauses and a
// small indicator appears until they click it or scroll back down themselves).
const chatFollowBottom = new WeakMap();
const CHAT_SCROLL_BOTTOM_THRESHOLD = 4;

function isScrolledToBottom(el) {
  return (
    el.scrollHeight - el.scrollTop - el.clientHeight <=
    CHAT_SCROLL_BOTTOM_THRESHOLD
  );
}

function updateChatScrollIndicator(chatDiv) {
  if (!chatDiv) return;
  const row = chatDiv.closest(".chat-row");
  if (!row) return;
  const overflowing = chatDiv.scrollHeight > chatDiv.clientHeight + 1;
  if (!overflowing) {
    chatFollowBottom.set(chatDiv, true);
    row.classList.remove("has-more-below");
    return;
  }
  if (chatFollowBottom.get(chatDiv) !== false) {
    chatDiv.scrollTop = chatDiv.scrollHeight;
    row.classList.remove("has-more-below");
  } else {
    row.classList.add("has-more-below");
  }
}

// ── MARKDOWN-LITE: CODE ──────────────────────────────────────────────────
// Splits a raw message into ordered {type, value} segments so fenced/inline
// code content never reaches the word filter, emotes, links, or emphasis
// (backticks escape their contents, same as everywhere else markdown works).

// Phase 1: pull out ```fenced``` blocks, line by line. An unterminated fence
// runs to the end of the message rather than swallowing nothing.
function splitCodeBlocks(text) {
  const lines = text.split("\n");
  const segments = [];
  let buf = [];
  const flushText = () => {
    if (buf.length) segments.push({ type: "text", value: buf.join("\n") });
    buf = [];
  };
  let i = 0;
  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) {
      flushText();
      i++;
      const block = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) block.push(lines[i++]);
      i++; // consume the closing fence, if there is one
      segments.push({ type: "code-block", value: block.join("\n") });
      continue;
    }
    buf.push(lines[i]);
    i++;
  }
  flushText();
  return segments;
}

// Phase 2: within each remaining text segment, pull out `inline code` spans.
// Content is restricted to a single line so a forgotten closing backtick
// can't swallow the rest of the message.
function splitInlineCode(segments) {
  const result = [];
  const inlineRe = /(`+)([^\n]+?)\1/g;
  for (const seg of segments) {
    if (seg.type !== "text") {
      result.push(seg);
      continue;
    }
    let last = 0;
    let match;
    inlineRe.lastIndex = 0;
    while ((match = inlineRe.exec(seg.value)) !== null) {
      if (match.index > last)
        result.push({ type: "text", value: seg.value.slice(last, match.index) });
      result.push({ type: "code-inline", value: match[2] });
      last = match.index + match[0].length;
    }
    if (last < seg.value.length)
      result.push({ type: "text", value: seg.value.slice(last) });
  }
  return result;
}

function createCodeNode(text, isBlock) {
  const node = document.createElement(isBlock ? "pre" : "code");
  node.className = isBlock ? "chat-code-block" : "chat-code-inline";
  node.textContent = text;
  return node;
}

// ── MARKDOWN-LITE: BOLD/ITALIC ──────────────────────────────────────────────
// Non-destructive text-node walk, same shape as linkifyElement() below: it
// must run AFTER replaceEmotes() (which does a full innerHTML rebuild) and
// is safe to run after linkifyElement() since it skips .chat-link contents.
const EMPHASIS_PATTERN =
  /\*\*([^\n]+?)\*\*|__([^\n]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_/g;

function applyEmphasis(element) {
  if (!element) return;

  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false,
  );
  const candidates = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (
      node.parentNode?.closest?.(
        ".chat-link, .chat-code-inline, .chat-code-block",
      )
    )
      continue;
    EMPHASIS_PATTERN.lastIndex = 0;
    if (EMPHASIS_PATTERN.test(node.textContent)) candidates.push(node);
  }

  for (const node of candidates) {
    const text = node.textContent;
    const frag = document.createDocumentFragment();
    let last = 0;
    let found = false;
    let match;

    EMPHASIS_PATTERN.lastIndex = 0;
    while ((match = EMPHASIS_PATTERN.exec(text)) !== null) {
      const before = match.index > 0 ? text[match.index - 1] : "";
      const after = text[EMPHASIS_PATTERN.lastIndex] || "";
      // snake_case and file_names are not italics.
      if (match[4] != null && (/\w/.test(before) || /\w/.test(after))) continue;

      frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      const inner = match[1] ?? match[2] ?? match[3] ?? match[4];
      const tag = match[1] != null || match[2] != null ? "strong" : "em";
      const emphasisEl = document.createElement(tag);
      emphasisEl.textContent = inner;
      frag.appendChild(emphasisEl);

      last = match.index + match[0].length;
      found = true;
    }

    if (!found) continue;
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

// Runs word filter → emotes → link detection → emphasis on a plain-text
// segment, inside a detached wrapper so the existing (element-wide) helpers
// can be reused unmodified: their "is this the focused element" branches
// simply no-op on a disconnected node.
function buildTextSegmentNodes(text) {
  const wrapper = document.createElement("span");
  const display = applyWordFilter(text);
  wrapper.appendChild(document.createTextNode(display));
  replaceEmotes(wrapper);
  linkifyElement(wrapper);
  applyEmphasis(wrapper);
  return wrapper;
}

// Renders another user's message: code segments are carved out first, then
// each remaining text segment gets filter/emotes/links/emphasis, then any
// image-link thumbnails are added.
function renderOtherUserMessage(element, rawMessage) {
  if (!element) return;
  element.dataset.rawText = rawMessage;
  element.innerHTML = "";

  const frag = document.createDocumentFragment();
  const segments = splitInlineCode(splitCodeBlocks(rawMessage));
  for (const seg of segments) {
    if (seg.type === "code-inline") {
      frag.appendChild(createCodeNode(seg.value, false));
    } else if (seg.type === "code-block") {
      frag.appendChild(createCodeNode(seg.value, true));
    } else {
      const wrapper = buildTextSegmentNodes(seg.value);
      while (wrapper.firstChild) frag.appendChild(wrapper.firstChild);
    }
  }
  element.appendChild(frag);
  addImageThumbnails(element);
  updateChatScrollIndicator(element);
}

function updateCurrentMessages(messages) {
  Object.keys(messages).forEach((uid) => {
    const chatDiv = document.querySelector(
      `.chat-row[data-user-id="${uid}"] .chat-input`,
    );
    if (!chatDiv) return;
    const text = messages[uid].slice(0, MAX_MESSAGE_LENGTH);
    if (uid === currentUserId) {
      selfRawText = text;
      lastSentMessage = text;
      const isActive = document.activeElement === chatDiv;
      selfIsFiltered = wordFilterEnabled && clientWordFilter?.ready;
      if (isActive) {
        const cursor = getCursorPosition(chatDiv);
        const display = applyWordFilter(text);
        chatDiv.innerHTML = "";
        chatDiv.textContent = display;
        replaceEmotes(chatDiv);
        try {
          setCursorPosition(chatDiv, Math.min(cursor, display.length));
        } catch {
          placeCursorAtEnd(chatDiv);
        }
      } else {
        const display = applyWordFilter(text);
        chatDiv.innerHTML = "";
        chatDiv.textContent = display;
        replaceEmotes(chatDiv);
      }
    } else {
      renderOtherUserMessage(chatDiv, text);
    }
  });
}

function displayChatMessage(data) {
  const chatDiv = document.querySelector(
    `.chat-row[data-user-id="${data.userId}"] .chat-input`,
  );
  if (!chatDiv) return;

  let currentText =
    data.userId !== currentUserId
      ? chatDiv.dataset.rawText !== undefined
        ? chatDiv.dataset.rawText
        : getPlainText(chatDiv)
      : selfRawText;
  let newText = "";
  if (data.diff) {
    if (data.diff.type === "full-replace") newText = data.diff.text;
    else if (data.diff.type === "add")
      newText =
        currentText.slice(0, data.diff.index) +
        data.diff.text +
        currentText.slice(data.diff.index);
    else if (data.diff.type === "delete")
      newText =
        currentText.slice(0, data.diff.index) +
        currentText.slice(data.diff.index + data.diff.count);
    else if (data.diff.type === "replace")
      newText =
        currentText.slice(0, data.diff.index) +
        data.diff.text +
        currentText.slice(data.diff.index + data.diff.text.length);
  } else if (data.message) newText = data.message;
  else return;
  newText = newText.slice(0, MAX_MESSAGE_LENGTH);

  if (data.userId === currentUserId) {
    selfRawText = newText;
    lastSentMessage = newText;
    const isActive = document.activeElement === chatDiv;
    selfIsFiltered = wordFilterEnabled && clientWordFilter?.ready;
    if (isActive) {
      const cursor = getCursorPosition(chatDiv);
      const display = applyWordFilter(selfRawText);
      chatDiv.innerHTML = "";
      chatDiv.textContent = display;
      if (/[;:]/.test(display)) replaceEmotes(chatDiv);
      try {
        setCursorPosition(chatDiv, Math.min(cursor, display.length));
      } catch {
        placeCursorAtEnd(chatDiv);
      }
    } else {
      renderOtherUserMessage(chatDiv, newText);
    }
  } else {
    if (notificationsEnabled && document.hidden) showTabDot();
    renderOtherUserMessage(chatDiv, newText);
  }
}

// ── 11. LINK SAFETY ─────────────────────────────────────────────────────────
// URLs in OTHER users' messages are wrapped in .chat-link spans, never real
// anchors. Clicking one opens a warning popup explaining that strange links
// can log your IP or scam you; navigation only happens after confirmation,
// in a new tab with noopener/noreferrer. The user's own input is NOT
// linkified because it is a contenteditable with delicate caret handling.

// A whole URL is "everything up to whitespace": after the domain we capture the
// full path / query / fragment ([\/?#] then anything non-space), so slugs and
// handles like youtube.com/@mohdmahmodi are part of the link, not just the host.
const URL_PATTERN = new RegExp(
  "(?:https?:\\/\\/[^\\s<>\"']+)" +
  "|(?:www\\.[^\\s<>\"']+)" +
  "|(?:\\b[a-z0-9](?:[a-z0-9-]*[a-z0-9])?" +
  "(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*" +
  "\\.(?:com|net|org|io|gg|co|me|app|dev|xyz|info|link|site|online|club|live|stream|fun|top|cc|tv|to|gl|ly|us|uk|ca|eu|de|fr|es|it|nl|jp|kr|in|br|au|ru|cn|edu|gov|biz|pro|tech|store|shop|blog|news|wiki|games|chat|space|world|media|tube|ai|so|sh|fm|im|re)" +
  "(?:[\\/?#][^\\s<>\"']*)?)",
  "gi",
);

const TRAILING_PUNCTUATION = /[.,!?;:)\]}'"]+$/;

let linkWarningOverlay = null;
let pendingLinkUrl = "";

// Walks the text nodes of a rendered message and wraps detected URLs in
// .chat-link spans. Only TEXT nodes are visited, so emote <img> elements
// are untouched. Runs after replaceEmotes().
function linkifyElement(element) {
  if (!element) return;

  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false,
  );
  const candidates = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node.parentNode?.closest?.(".chat-link")) continue;
    URL_PATTERN.lastIndex = 0;
    if (URL_PATTERN.test(node.textContent)) candidates.push(node);
  }

  for (const node of candidates) {
    const text = node.textContent;
    const frag = document.createDocumentFragment();
    let last = 0;
    let found = false;
    let match;

    URL_PATTERN.lastIndex = 0;
    while ((match = URL_PATTERN.exec(text)) !== null) {
      const url = match[0].replace(TRAILING_PUNCTUATION, "");
      if (!url) continue;

      frag.appendChild(document.createTextNode(text.slice(last, match.index)));

      const span = document.createElement("span");
      span.className = "chat-link";
      span.dataset.url = url;
      span.title = "Outside link. Click for safety info.";
      span.textContent = url;
      frag.appendChild(span);

      last = match.index + url.length;
      found = true;
    }

    if (!found) continue;
    frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

// Renders a small preview alongside (not instead of) the existing
// safety-gated .chat-link text. https-only: a schemeless URL set as img.src
// would resolve as a relative path against Talkomatic's own origin instead
// of the external site. A broken image just removes itself, leaving the
// link text intact and still clickable.
const IMAGE_EXT_PATTERN = /\.(?:png|jpe?g|gif|webp)(?:[?#][^\s]*)?$/i;

function addImageThumbnails(element) {
  if (!element) return;
  const links = element.querySelectorAll(".chat-link");
  for (const span of links) {
    const url = span.dataset.url;
    if (!url || !/^https:\/\//i.test(url) || !IMAGE_EXT_PATTERN.test(url))
      continue;
    const img = document.createElement("img");
    img.className = "chat-img-thumb";
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.loading = "lazy";
    img.alt = "";
    img.src = url;
    img.onerror = () => img.remove();
    span.insertAdjacentElement("afterend", img);
  }
}

function createLinkWarningModal() {
  linkWarningOverlay = document.createElement("div");
  linkWarningOverlay.className = "link-warning-overlay";

  const box = document.createElement("div");
  box.className = "link-warning-box";

  const icon = document.createElement("div");
  icon.className = "link-warning-icon";
  icon.textContent = "\u26A0\uFE0F";

  const title = document.createElement("div");
  title.className = "link-warning-title";
  title.textContent = "You Are Leaving Talkomatic";

  const body = document.createElement("div");
  body.textContent =
    "This link was posted by another user. The site behind it can log " +
    "your IP address, estimate your location, or try to scam you. Never " +
    "trust links from strangers. The safest option is to type the address " +
    "yourself in a new tab, on your own.";

  const urlBox = document.createElement("div");
  urlBox.className = "link-warning-url";

  const note = document.createElement("div");
  note.className = "link-warning-note";
  note.textContent =
    "Talkomatic does not check or endorse outside links. Continue only if " +
    "you know and trust this site.";

  const buttons = document.createElement("div");
  buttons.className = "link-warning-buttons";

  const backBtn = document.createElement("button");
  backBtn.className = "link-warning-back";
  backBtn.textContent = "Go Back";
  backBtn.addEventListener("click", hideLinkWarning);

  const visitBtn = document.createElement("button");
  visitBtn.className = "link-warning-visit";
  visitBtn.textContent = "Visit At My Own Risk";
  visitBtn.addEventListener("click", () => {
    let target = pendingLinkUrl;
    if (!target) return hideLinkWarning();
    if (!/^https?:\/\//i.test(target)) target = "https://" + target;
    window.open(target, "_blank", "noopener,noreferrer");
    hideLinkWarning();
  });

  buttons.appendChild(backBtn);
  buttons.appendChild(visitBtn);

  box.appendChild(icon);
  box.appendChild(title);
  box.appendChild(body);
  box.appendChild(urlBox);
  box.appendChild(note);
  box.appendChild(buttons);
  linkWarningOverlay.appendChild(box);

  linkWarningOverlay.addEventListener("click", (e) => {
    if (e.target === linkWarningOverlay) hideLinkWarning();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && linkWarningOverlay.classList.contains("show")) {
      hideLinkWarning();
    }
  });

  document.body.appendChild(linkWarningOverlay);
}

function showLinkWarning(url) {
  if (!url) return;
  if (!linkWarningOverlay) createLinkWarningModal();
  pendingLinkUrl = url;
  linkWarningOverlay.querySelector(".link-warning-url").textContent = url;
  linkWarningOverlay.classList.add("show");
}

function hideLinkWarning() {
  if (!linkWarningOverlay) return;
  linkWarningOverlay.classList.remove("show");
  pendingLinkUrl = "";
}

// One delegated click listener on the static chat container, so it survives
// every room update that rebuilds the rows inside it
function initLinkSafety() {
  const container = document.querySelector(".chat-container");
  if (!container) return;
  container.addEventListener("click", (e) => {
    const link = e.target.closest?.(".chat-link");
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    showLinkWarning(link.dataset.url);
  });
}

// ── 12. DEV MODE: Confetti & Navbar Controls ────────────────────────────────

// Self-contained confetti burst shown when a dev joins
function triggerDevConfetti() {
  const container = document.createElement("div");
  container.style.cssText =
    "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99999;overflow:hidden;";
  document.body.appendChild(container);

  const colors = [
    "#ff9800",
    "#ff4444",
    "#00ffff",
    "#ffd700",
    "#ff69b4",
    "#44ff44",
    "#ff44ff",
    "#4488ff",
  ];
  const pieces = [];

  for (let i = 0; i < 80; i++) {
    const el = document.createElement("div");
    const color = colors[Math.floor(Math.random() * colors.length)];
    const size = 6 + Math.random() * 10;
    const startX = Math.random() * window.innerWidth;
    const startY = -20 - Math.random() * 100;
    const speed = 2 + Math.random() * 4;
    const drift = (Math.random() - 0.5) * 3;
    const rotSpeed = (Math.random() - 0.5) * 12;

    el.style.cssText = `position:absolute;width:${size}px;height:${size * 0.6}px;background:${color};border-radius:2px;left:0;top:0;pointer-events:none;`;
    container.appendChild(el);
    pieces.push({ el, x: startX, y: startY, speed, drift, rot: 0, rotSpeed });
  }

  let frame;
  function animate() {
    let alive = false;
    for (const p of pieces) {
      p.y += p.speed;
      p.x += p.drift;
      p.rot += p.rotSpeed;
      if (p.y < window.innerHeight + 50) alive = true;
      const opacity = Math.max(0, 1 - p.y / window.innerHeight);
      p.el.style.transform = `translate(${p.x}px, ${p.y}px) rotate(${p.rot}deg)`;
      p.el.style.opacity = opacity;
    }
    if (alive) {
      frame = requestAnimationFrame(animate);
    } else {
      cancelAnimationFrame(frame);
      container.remove();
    }
  }
  frame = requestAnimationFrame(animate);

  setTimeout(() => {
    cancelAnimationFrame(frame);
    if (container.parentNode) container.remove();
  }, 5000);
}

function createDevColorPicker() {
  const navRight = document.querySelector(".navbar-right");
  if (!navRight || document.getElementById("devColorPicker")) return;

  const wrapper = document.createElement("div");
  wrapper.id = "devColorPicker";
  wrapper.style.cssText =
    "display:flex;align-items:center;gap:6px;margin-right:8px;";

  const label = document.createElement("span");
  label.textContent = "Color:";
  label.style.cssText = "color:#ff9800;font-size:12px;";

  const input = document.createElement("input");
  input.type = "color";
  input.value = localStorage.getItem("talkomatic_devColor") || "#ff9800";
  input.title = "Change your text color";
  input.style.cssText =
    "width:28px;height:28px;border:1px solid #555;border-radius:4px;cursor:pointer;background:none;padding:0;";

  input.addEventListener("input", (e) => {
    const color = e.target.value;
    localStorage.setItem("talkomatic_devColor", color);
    socket.emit("dev set color", { color });
    applyDevColor(color);
  });

  wrapper.appendChild(label);
  wrapper.appendChild(input);

  const leaveBtn = navRight.querySelector(".leave-room");
  if (leaveBtn) {
    navRight.insertBefore(wrapper, leaveBtn);
  } else {
    navRight.appendChild(wrapper);
  }

  const savedColor = localStorage.getItem("talkomatic_devColor");
  if (savedColor) {
    socket.emit("dev set color", { color: savedColor });
    applyDevColor(savedColor);
  }
}

function getCurrentUserRow() {
  return document.querySelector(`.chat-row[data-user-id="${currentUserId}"]`);
}

function applyDevAppearanceToRow(row, user) {
  if (!row || !user) return;

  const info = row.querySelector(".user-info");
  const ci = row.querySelector(".chat-input");
  if (!info || !ci) return;

  // A dev viewer sees concealed staff (hidden/vanished) with their badge, but
  // never the loud flair, plus a marker. Other viewers behave as before.
  const devSeesConcealed = currentUserIsDev && user.id !== currentUserId;
  const crown = info.querySelector(".dev-crown");
  const loudDev = !!user.isDev && !user.isHidden;
  const showCrown = !!user.isDev && (!user.isHidden || devSeesConcealed);

  // Loud mod flair follows the same hide rule as the dev flair, keyed to rank.
  const loudMod = !!user.isMod && !user.isDev && !user.isHidden;
  const modRowClass =
    loudMod && (user.modLevel || 2) >= 2
      ? "mod-user"
      : loudMod
        ? "jrmod-user"
        : null;
  const modTextClass =
    loudMod && (user.modLevel || 2) >= 2
      ? "mod-glow-text"
      : loudMod
        ? "jrmod-glow-text"
        : null;

  row.classList.remove("mod-user", "jrmod-user");
  ci.classList.remove("mod-glow-text", "jrmod-glow-text");

  if (loudDev) {
    row.classList.add("dev-user");
    ci.classList.add("dev-fire-text");

    if (user.devColor) {
      ci.style.setProperty("color", user.devColor, "important");
    }
  } else {
    row.classList.remove("dev-user");
    ci.classList.remove("dev-fire-text");
    ci.style.removeProperty("color");
    if (modRowClass) row.classList.add(modRowClass);
    if (modTextClass) ci.classList.add(modTextClass);
  }

  if (showCrown) {
    if (!crown) {
      const crownImg = document.createElement("img");
      crownImg.src = "images/icons/crown.gif";
      crownImg.alt = "Dev";
      crownImg.className = "dev-crown";
      info.insertBefore(crownImg, info.firstChild);
    }
  } else if (crown) {
    crown.remove();
  }

  // Mod badge (distinct from the dev crown), toggled by hide state
  const modBadge = info.querySelector(".mod-badge");
  const showModFlair =
    !!user.isMod && !user.isDev && (!user.isHidden || devSeesConcealed);
  const wantLevel = user.modLevel || 2;
  if (showModFlair) {
    if (!modBadge)
      info.insertBefore(createModBadge(wantLevel), info.firstChild);
    else if (Number(modBadge.dataset.level) !== wantLevel)
      modBadge.replaceWith(createModBadge(wantLevel));
  } else if (modBadge) {
    modBadge.remove();
  }

  // Dev-only marker showing this staffer is hidden/vanished from normal users.
  const marker = info.querySelector(".staff-concealed-marker");
  const showMarker =
    devSeesConcealed &&
    (user.isDev || user.isMod) &&
    (user.isHidden || user.isVanished);
  if (showMarker) {
    const fresh = makeStaffConcealedMarker(user);
    if (!marker) info.appendChild(fresh);
    else if (marker.dataset.state !== fresh.dataset.state)
      marker.replaceWith(fresh);
  } else if (marker) {
    marker.remove();
  }
}

function refreshCurrentUserAppearance() {
  const row = getCurrentUserRow();
  if (!row) return;

  const user = {
    id: currentUserId,
    isDev: currentUserIsDev,
    isMod: currentUserIsMod,
    modLevel: currentUserModLevel,
    isHidden: currentUserIsHidden,
    devColor:
      currentUserIsDev && !currentUserIsHidden
        ? localStorage.getItem("talkomatic_devColor") || null
        : null,
  };

  applyDevAppearanceToRow(row, user);
}

function applyDevColor(color) {
  refreshCurrentUserAppearance();
}

function updateDevVanishButton(button) {
  if (!button) return;
  button.textContent = currentUserIsVanished ? "Vanish: ON" : "Vanish: OFF";
  button.title = currentUserIsVanished
    ? "You are vanished. Click to appear public."
    : "You are public. Click to vanish from normal users.";
}

function createDevVanishToggle() {
  const navRight = document.querySelector(".navbar-right");
  if (!navRight || document.getElementById("devVanishToggle")) return;

  const button = document.createElement("button");
  button.id = "devVanishToggle";
  button.type = "button";
  button.style.cssText =
    "display:flex;align-items:center;gap:6px;margin-right:8px;padding:6px 10px;border:1px solid #555;border-radius:4px;background:#111;color:#ff9800;cursor:pointer;font-size:12px;";

  updateDevVanishButton(button);

  button.addEventListener("click", () => {
    if (!socket.connected) return;
    socket.emit("dev set vanish", { isVanished: !currentUserIsVanished });
  });

  const leaveBtn = navRight.querySelector(".leave-room");
  if (leaveBtn) navRight.insertBefore(button, leaveBtn);
  else navRight.appendChild(button);
}

function updateDevHideButton(button) {
  if (!button) return;
  button.textContent = currentUserIsHidden ? "Hide: ON" : "Hide: OFF";
  button.title = currentUserIsHidden
    ? "Your dev flair is hidden from everyone. Click to show it again."
    : "Your dev flair is visible. Click to hide crown, color, and glow.";
}

function createDevHideToggle() {
  const navRight = document.querySelector(".navbar-right");
  if (!navRight || document.getElementById("devHideToggle")) return;

  const button = document.createElement("button");
  button.id = "devHideToggle";
  button.type = "button";
  button.style.cssText =
    "display:flex;align-items:center;gap:6px;margin-right:8px;padding:6px 10px;border:1px solid #555;border-radius:4px;background:#111;color:#ff9800;cursor:pointer;font-size:12px;";

  updateDevHideButton(button);

  button.addEventListener("click", () => {
    if (!socket.connected) return;
    socket.emit("dev set hide", { isHidden: !currentUserIsHidden });
  });

  const leaveBtn = navRight.querySelector(".leave-room");
  if (leaveBtn) navRight.insertBefore(button, leaveBtn);
  else navRight.appendChild(button);
}

// Dev-only overlay showing per-user context (IP) in the room, toggleable so it
// never has to crowd the chat. Mods can act on users (kick / ban / IP-block)
// but never see raw IP addresses.
let devShowIP = localStorage.getItem("talkomatic_devShowIP") !== "false";
function renderDevContext() {
  if (!currentUserIsDev) return;
  document.querySelectorAll(".chat-row").forEach((row) => {
    const uid = row.dataset.userId;
    const info = row.querySelector(".user-info");
    if (!info) return;

    const existing = info.querySelector(".dev-meta");
    if (existing) existing.remove();
    if (!devShowIP) return;

    const meta = devContext.get(uid);
    if (meta && meta.d) {
      const span = document.createElement("span");
      span.className = "dev-meta";
      span.textContent = meta.d;
      info.appendChild(span);
    }
  });
}

socket.on("dev context", (ctx) => {
  devContext.clear();
  for (const [uid, data] of Object.entries(ctx)) {
    devContext.set(uid, data);
  }
  renderDevContext();
});

// Update a still-open Staff panel item's label in place. The panel keeps items
// open after a click, so a toggle's label would otherwise stay stale until the
// panel is reopened.
function setStaffItemLabel(id, label) {
  const item = document.getElementById(id);
  if (!item) return;
  const lbl = item.querySelector(".tk-ilabel");
  if (lbl) lbl.textContent = label;
}

socket.on("dev vanish status", (data) => {
  currentUserIsVanished = !!data?.isVanished;
  const button = document.getElementById("devVanishToggle");
  updateDevVanishButton(button);
  setStaffItemLabel(
    "staffVanishItem",
    currentUserIsVanished ? "Vanish: ON" : "Vanish: OFF",
  );
});

socket.on("dev hide status", (data) => {
  currentUserIsHidden = !!data?.isHidden;
  // Persist the choice so it survives refreshes and restarts: it is re-applied
  // on every room join below (the server session alone loses it on a restart).
  try {
    localStorage.setItem(
      "talkomatic_devHidden",
      currentUserIsHidden ? "1" : "0",
    );
  } catch (_) { }
  const button = document.getElementById("devHideToggle");
  updateDevHideButton(button);
  setStaffItemLabel(
    "staffHideItem",
    currentUserIsHidden ? "Show my flair" : "Hide my flair",
  );
  refreshCurrentUserAppearance();
  renderDevContext();
});

// ── 13. ROOM UI ─────────────────────────────────────────────────────────────

// Small device-type indicator shown at the left of each user row. Derived from
// the user agent on the server, purely cosmetic.
const DEVICE_META = {
  desktop: { icon: "fas fa-desktop", title: "Desktop" },
  mobile: { icon: "fas fa-mobile-screen-button", title: "Mobile" },
  qwerty: { icon: "fas fa-tty", title: "QWERTY Phone" },
  tablet: { icon: "fas fa-tablet-screen-button", title: "Tablet" },
  tv: { icon: "fas fa-tv", title: "TV" },
  vr: { icon: "fas fa-vr-cardboard", title: "VR" },
  console: { icon: "fas fa-gamepad", title: "Console" },
  watch: { icon: "fas fa-clock", title: "Watch" },
  ereader: { icon: "fas fa-book-atlas", title: "E-Reader" },
  car: { icon: "fas fa-car", title: "Car" },
  raspi: { icon: "fab fa-raspberry-pi", title: "Raspberry Pi" }, // this uses fab instead of fas
  projector: { icon: "fas fa-film", title: "Projector" },
  refrigerator: { icon: "fas fa-snowflake", title: "Refrigerator" },
  bot: { icon: "fas fa-robot", title: "Bot" },
  unknown: { icon: "fas fa-circle-question", title: "Unknown" },
};
function deviceIconFor(type) {
  const m = DEVICE_META[type] || DEVICE_META.unknown;
  const i = document.createElement("i");
  i.className = m.icon + " device-icon";
  i.title = m.title;
  i.setAttribute("aria-hidden", "true");
  return i;
}

// Top-3 inviter trophy images (gold/silver/bronze) shown left of the username.
const TROPHY_SRC = {
  1: "images/icons/trophy-gold.png",
  2: "images/icons/trophy-silver.png",
  3: "images/icons/trophy-bronze.png",
};
function trophyImgFor(rank) {
  const src = TROPHY_SRC[rank];
  if (!src) return null;
  const img = document.createElement("img");
  img.src = src;
  img.alt = "";
  img.className = "invite-trophy";
  img.title =
    rank === 1
      ? "Top inviter"
      : rank === 2
        ? "2nd most invites"
        : "3rd most invites";
  img.onerror = function () {
    this.style.display = "none";
  };
  return img;
}

function syncUserRowNote(row, user) {
  if (!row || !user) return;
  const note = typeof user.note === "string" ? user.note : "";
  row.dataset.note = note;
  const noteBtn = row.querySelector(".note-action-button");
  if (noteBtn) noteBtn.classList.toggle("has-note", !!note);
}

// ── Panel Style (per-user chat panel border/background/text color) ─────────
// Scoped to the chat panel ONLY (.chat-row / .chat-input), never the rest of
// the app - unlike theme-engine.js, which themes the whole page. Applied as
// CSS custom properties on the row so it works for every user's row (this is
// shared UI, everyone in the room sees everyone else's panel), not just the
// local user's.
const PANEL_STYLE_KEY = "talkomatic_panelStyle";

// The room's true default colors, independent of any room-wide theme token
// (--tk-accent/--tk-chat-bg/--tk-chat-text). Must stay in sync with
// theme-engine.js's TOKENS defaults and room.css's :root block - duplicated
// here (rather than read live) so "Reset to default" is reachable even for
// users whose stale pre-CHAT-12 whole-page theme still overrides those
// tokens at :root, since the room UI no longer offers a way to clear it.
const TRUE_DEFAULT_PANEL_STYLE = { border: "#ffa500", bg: "#000000", text: "#ffa500" };

function loadSavedPanelStyle() {
  try {
    const raw = localStorage.getItem(PANEL_STYLE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;

    const hexPattern = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
    const style = {
      border: hexPattern.test(String(parsed.border || "")) ? String(parsed.border) : null,
      bg: hexPattern.test(String(parsed.bg || "")) ? String(parsed.bg) : null,
      text: hexPattern.test(String(parsed.text || "")) ? String(parsed.text) : null,
    };

    return style.border || style.bg || style.text ? style : null;
  } catch (e) {}
  return null;
}

// The server only holds panelStyle for the lifetime of a room membership, so on
// a reload or rejoin our own style is missing from the first snapshots. The
// localStorage copy is the durable one - fall back to it for our own row until
// the server echoes our re-broadcast back to us.
function resolvePanelStyle(user) {
  if (user && user.panelStyle) return user.panelStyle;
  if (user && user.id === currentUserId) return loadSavedPanelStyle();
  return null;
}

function savePanelStyle(style) {
  const hasAny = style && (style.border || style.bg || style.text);
  if (hasAny) localStorage.setItem(PANEL_STYLE_KEY, JSON.stringify(style));
  else localStorage.removeItem(PANEL_STYLE_KEY);
}

function applyPanelStyleToRow(row, user) {
  if (!row) return;
  const style = resolvePanelStyle(user);
  const vars = {
    "--tk-row-border": style && style.border,
    "--tk-row-chat-bg": style && style.bg,
    "--tk-row-chat-text": style && style.text,
    "--tk-row-chat-bg-inv": style && style.text ? invertHsv(style.text) : null,
  };
  for (const [prop, val] of Object.entries(vars)) {
    if (val) row.style.setProperty(prop, val);
    else row.style.removeProperty(prop);
  }
}

// No server-side rate limiter exists for this event (unlike chat/typing), so
// the client-side debounce is the only mitigation and is treated as required.
let panelStyleEmitTimer = null;
function emitPanelStyle(style) {
  clearTimeout(panelStyleEmitTimer);
  panelStyleEmitTimer = setTimeout(() => {
    socket.emit("set panel style", style || {});
  }, 400);
}

// Builds the 3 inline color swatches (border/background/text) + reset-all
// button shown directly in your own row - no popover/dialog, every change
// applies and saves on the "input" event itself (fires per keystroke/drag
// on a color input), so nothing needs an explicit save/confirm step.
function buildPanelStyleControls(row, user) {
  const wrap = document.createElement("div");
  wrap.className = "panel-style-inline";

  const current = resolvePanelStyle(user) || {};
  const draft = {
    border: current.border || null,
    bg: current.bg || null,
    text: current.text || null,
  };

  const commit = () => {
    applyPanelStyleToRow(row, { panelStyle: draft });
    savePanelStyle(draft);
    emitPanelStyle(draft);
  };

  // An untouched swatch shows the same color a reset would produce. Read from
  // the constants rather than getComputedStyle(): on a hard reload this runs
  // before room.css has necessarily applied, and the computed value would
  // then be the UA default (black) for all three.
  const hexPattern = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

  const makeSwatch = (title, initial, onChange) => {
    const input = document.createElement("input");
    input.type = "color";
    input.className = "panel-style-swatch";
    input.title = title;
    input.setAttribute("aria-label", title);
    input.value = initial && hexPattern.test(initial) ? initial : "#000000";
    input.addEventListener("input", () => onChange(input.value));
    wrap.appendChild(input);
    return input;
  };

  const borderInput = makeSwatch(
    "Panel border color",
    draft.border || TRUE_DEFAULT_PANEL_STYLE.border,
    (v) => {
      draft.border = v;
      commit();
    },
  );
  const bgInput = makeSwatch(
    "Panel background color",
    draft.bg || TRUE_DEFAULT_PANEL_STYLE.bg,
    (v) => {
      draft.bg = v;
      commit();
    },
  );
  const textInput = makeSwatch(
    "Panel text color",
    draft.text || TRUE_DEFAULT_PANEL_STYLE.text,
    (v) => {
      draft.text = v;
      commit();
    },
  );

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "panel-style-reset";
  resetBtn.innerHTML = '<i class="fas fa-rotate-left"></i>';
  resetBtn.title = "Reset panel colors to default";
  resetBtn.setAttribute("aria-label", "Reset panel colors to default");
  resetBtn.addEventListener("click", () => {
    Object.assign(draft, TRUE_DEFAULT_PANEL_STYLE);
    borderInput.value = draft.border;
    bgInput.value = draft.bg;
    textInput.value = draft.text;
    applyPanelStyleToRow(row, { panelStyle: draft });
    savePanelStyle(draft);
    clearTimeout(panelStyleEmitTimer);
    socket.emit("set panel style", draft);
  });
  wrap.appendChild(resetBtn);

  return wrap;
}

function createUserRow(user, container) {
  const row = document.createElement("div");
  row.classList.add("chat-row");
  if (user.id === currentUserId) row.classList.add("current-user");
  if (user.departed) row.classList.add("departed");
  row.dataset.userId = user.id;
  row.dataset.username = user.username || "";

  // A dev viewer always gets to see who is staff, even staff who are hidden or
  // vanished from normal users (the server only sends those flags to devs). The
  // loud row styling stays off for concealed staff - just the badge + a marker.
  const devSeesConcealed = currentUserIsDev && user.id !== currentUserId;

  // Rank flair on the row itself: dev red, full mod (L2) blue, junior mod (L1)
  // purple. Hidden staff get no loud styling, same rule as the dev crown.
  if (user.isDev && !user.isHidden) {
    row.classList.add("dev-user");
  } else if (user.isMod && !user.isDev && !user.isHidden) {
    row.classList.add(
      (user.modLevel || 2) >= 2 ? "mod-user" : "jrmod-user",
    );
  }

  syncUserRowNote(row, user);

  const info = document.createElement("span");
  info.className = "user-info";

  info.appendChild(deviceIconFor(user.deviceType));

  const rowTrophy = trophyImgFor(user.inviteRank);
  if (rowTrophy) info.appendChild(rowTrophy);

  if (user.isDev && (!user.isHidden || devSeesConcealed)) {
    const crown = document.createElement("img");
    crown.src = "images/icons/crown.gif";
    crown.alt = "Dev";
    crown.className = "dev-crown";
    info.appendChild(crown);
  }

  if (user.isMod && !user.isDev && (!user.isHidden || devSeesConcealed)) {
    info.appendChild(createModBadge(user.modLevel));
  }

  // Dev-only marker telling the dev this staffer is hidden/vanished to others.
  if (devSeesConcealed && (user.isDev || user.isMod) && (user.isHidden || user.isVanished)) {
    info.appendChild(makeStaffConcealedMarker(user));
  }

  if (user.avatar) {
    const url = discordAvatarUrl(user.avatar, 32);
    if (url) {
      const pfp = document.createElement("img");
      pfp.className = "user-pfp";
      pfp.alt = "";
      pfp.src = url;
      pfp.onerror = () => (pfp.style.display = "none");
      info.appendChild(pfp);
    }
  }

  const nameEl = document.createElement("span");
  nameEl.className = "ui-name";
  nameEl.textContent = user.username;
  info.appendChild(nameEl);

  // Ghost: they left while the queue was empty, so their panel/text lingers
  // instead of disappearing. Marked, not disguised as still-present.
  if (user.departed) {
    const leftLabel = document.createElement("span");
    leftLabel.className = "departed-label";
    leftLabel.textContent = "left";
    info.appendChild(leftLabel);
  }

  // Vote-to-mute a bot: status label to the left of the vote button, both
  // shown only on bot rows (bots are any socket authenticated via a bot
  // token - see server/security.js - not a single hardcoded participant).
  if (user.isBot) {
    const muteStatusLabel = document.createElement("span");
    muteStatusLabel.className = "mute-status-label";
    muteStatusLabel.textContent = "Not muted";
    info.appendChild(muteStatusLabel);

    if (user.id !== currentUserId) {
      const voteMuteBtn = document.createElement("button");
      voteMuteBtn.className = "vote-mute-button";
      voteMuteBtn.innerHTML = "\uD83D\uDD25";
      voteMuteBtn.title = "Vote to mute this bot";
      voteMuteBtn.addEventListener("click", () => {
        socket.emit("vote mute", { targetUserId: user.id });
      });
      info.appendChild(voteMuteBtn);
    }
  }

  // Staff actions button (dev + mod, not on yourself). Shown while spectating
  // too, so staff can moderate a room they're only watching. Opens the per-user
  // staff menu (kick/ban, IP block, wipe, warn, rename, freeze). The server
  // re-checks role and hierarchy on every action.
  //
  // Only show it when this staff member could actually act on the target:
  // mods act on normal users only, devs on anyone but other devs. Hidden staff
  // read as normal here so the gear still shows for them (the server silently
  // rejects out-of-hierarchy actions), which avoids revealing who they are.
  const targetVisibleRole =
    user.isDev && !user.isHidden
      ? "dev"
      : user.isMod && !user.isHidden
        ? "mod"
        : null;
  const canActOnTarget = currentUserIsDev
    ? targetVisibleRole !== "dev"
    : currentUserIsMod
      ? targetVisibleRole === null
      : false;
  if (isStaff()) {
    const noteBtn = document.createElement("button");
    noteBtn.className = "staff-action-button note-action-button";
    noteBtn.innerHTML = '<i class="fas fa-sticky-note"></i>';
    noteBtn.title = "View/edit note";
    noteBtn.addEventListener("click", () => {
      const note = row.dataset.note || "";
      openUserNoteDialog({ ...user, note }, { viewOnly: false });
    });
    info.appendChild(noteBtn);

    if (user.id !== currentUserId && canActOnTarget) {
      const staffBtn = document.createElement("button");
      staffBtn.className = "staff-action-button";
      staffBtn.innerHTML = '<i class="fas fa-gear"></i>'; // gear
      staffBtn.title = "Staff actions";
      staffBtn.addEventListener("click", () => openUserStaffMenu(user));
      info.appendChild(staffBtn);
    }
  }
  // Chat input wrapper + contenteditable
  const wrapper = document.createElement("div");
  wrapper.className = "chat-input-wrapper";
  wrapper.style.cssText = "position:relative;width:100%;height:100%";

  const div = document.createElement("div");
  div.className = "chat-input";
  let scrollIndicator = null;

  if (user.isDev && !user.isHidden) {
    div.classList.add("dev-fire-text");
  } else if (user.isMod && !user.isDev && !user.isHidden) {
    div.classList.add(
      (user.modLevel || 2) >= 2 ? "mod-glow-text" : "jrmod-glow-text",
    );
  }

  div.contentEditable = user.id === currentUserId;
  div.style.cssText =
    "width:100%;height:100%;overflow-x:hidden;overflow-y:auto;padding:6px 8px;box-sizing:border-box;outline:none;white-space:pre-wrap;word-break:break-word;position:absolute;top:0;left:0;z-index:2";
  div.spellcheck = false;

  applyPanelStyleToRow(row, user);

  // Dev text color wins over a personal panel style, same precedence as the
  // dev/mod rank border flair below.
  if (user.devColor && user.isDev && !user.isHidden) {
    div.style.setProperty("color", user.devColor, "important");
  }

  if (user.id === currentUserId) {
    chatInput = div;
    div.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") || "";
      document.execCommand("insertText", false, text);
    });
    div.addEventListener("input", () => {
      const emoteInfo = findEmoteAtCursor();
      if (emoteInfo) {
        currentEmoteInfo = emoteInfo;
        showAutocomplete(emoteInfo.prefix);
      } else hideAutocomplete();
      const text = getPlainText(div);
      if (/[;:]/.test(text)) replaceEmotes(div);
      // Staff typing @mod/@dev raises a Desk ping server-side. A normal user
      // copying what they saw gets pointed at the tool that actually reaches
      // staff, instead of being silently ignored.
      if (
        !currentUserIsDev &&
        !currentUserIsMod &&
        /(^|\s)@(mod|dev)s?\b/i.test(text) &&
        Date.now() - (window._tkPingHintAt || 0) > 5 * 60 * 1000
      ) {
        window._tkPingHintAt = Date.now();
        if (window.toastr)
          toastr.info(
            "Typing @mod does not reach staff. To report someone, use the Report option on their name.",
          );
      }
      updateSentMessage();
    });
    div.addEventListener("keydown", (e) => {
      if (handleEmoteNavigation(e)) return;

      if (e.key === "Backspace" || e.key === "Delete") {
        const deleteDirection = e.key === "Backspace" ? "backward" : "forward";
        if (deleteEmoteNodeAtCaret(deleteDirection)) {
          e.preventDefault();
          if (getPlainText(div).trim() === "") div.innerHTML = "";
          if (/[;:]/.test(getPlainText(div))) replaceEmotes(div);
          updateSentMessage();
          return;
        }
      }

      // Ctrl/Cmd + Backspace or Delete with a selection (e.g. after Ctrl+A)
      // can leave text behind in contenteditable, so clear the selection
      // ourselves and sync. A collapsed cursor keeps the normal word-delete.
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "Backspace" || e.key === "Delete")
      ) {
        const sel = window.getSelection();
        if (sel && sel.rangeCount && !sel.isCollapsed) {
          e.preventDefault();
          sel.deleteFromDocument();
          if (getPlainText(div).trim() === "") div.innerHTML = "";
          updateSentMessage();
          return;
        }
      }

      if (e.ctrlKey || e.metaKey) return;
      if (
        getPlainText(div).length >= MAX_MESSAGE_LENGTH &&
        ![
          "Backspace",
          "Delete",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
        ].includes(e.key)
      ) {
        e.preventDefault();
      }
    });
    div.addEventListener("mousedown", (e) => e.stopPropagation());
    // Rich-render (code/emphasis/links/thumbnails, same pipeline as other
    // users) once the box stops being edited; revert to plain the instant
    // it's focused again so getPlainText()/updateSentMessage() always read
    // a lossless DOM (applyEmphasis/createCodeNode strip markdown delimiters
    // from the text content, which would corrupt the next keystroke).
    div.addEventListener("blur", () => {
      renderOtherUserMessage(div, selfRawText);
    });
    div.addEventListener("focus", () => {
      let cursor = 0;
      try {
        cursor = getCursorPosition(div);
      } catch {}
      const display =
        wordFilterEnabled && clientWordFilter?.ready
          ? applyWordFilter(selfRawText)
          : selfRawText;
      div.innerHTML = "";
      div.textContent = display;
      replaceEmotes(div);
      try {
        setCursorPosition(div, Math.min(cursor, display.length));
      } catch {
        placeCursorAtEnd(div);
      }
      selfIsFiltered = wordFilterEnabled && clientWordFilter?.ready;
    });
    setTimeout(() => div.focus(), 0);
  } else {
    // Extended chat indicator: only other users' boxes auto-follow/indicate,
    // since the current user's own typing already stays pinned via native
    // contenteditable caret behavior.
    chatFollowBottom.set(div, true);
    div.addEventListener("scroll", () => {
      chatFollowBottom.set(div, isScrolledToBottom(div));
      updateChatScrollIndicator(div);
    });

    scrollIndicator = document.createElement("button");
    scrollIndicator.type = "button";
    scrollIndicator.className = "chat-scroll-indicator";
    scrollIndicator.title = "Jump to latest";
    scrollIndicator.setAttribute(
      "aria-label",
      "More text below, jump to latest",
    );
    scrollIndicator.innerHTML = '<i class="fas fa-chevron-down"></i>';
    scrollIndicator.addEventListener("click", () => {
      chatFollowBottom.set(div, true);
      div.scrollTop = div.scrollHeight;
      row.classList.remove("has-more-below");
    });
  }

  wrapper.appendChild(div);
  if (scrollIndicator) wrapper.appendChild(scrollIndicator);
  row.appendChild(info);
  row.appendChild(wrapper);
  container.appendChild(row);

  // Panel style controls: only on your own row. Colors apply to this chat
  // panel only and are visible to everyone in the room (see applyPanelStyleToRow).
  if (user.id === currentUserId) {
    info.appendChild(buildPanelStyleControls(row, user));
  }

  adjustVoteButtonVisibility();
  return row;
}

function updateRoomUI(roomData) {
  const container = document.querySelector(".chat-container");
  if (!container) return;
  chatInput = null;

  // Defensive self-row guard. If a server-side race dropped our own membership
  // from this frame's user list, render our editable row anyway from what we
  // already know about ourselves - otherwise a self-less "room joined" leaves
  // the user with no textbox until a manual refresh. Mirrors the self-row
  // protection the "room update" handler already applies. Never for spectators
  // (read-only, no own row).
  let users =
    roomData.users && Array.isArray(roomData.users) ? roomData.users : [];
  if (
    !isSpectating &&
    currentUserId &&
    !users.some((u) => u.id === currentUserId)
  ) {
    users = [
      {
        id: currentUserId,
        username: currentUsername,
        location: currentLocation,
        isDev: currentUserIsDev,
        isMod: currentUserIsMod,
        modLevel: currentUserModLevel,
        isHidden: currentUserIsHidden,
        isVanished: currentUserIsVanished,
      },
      ...users,
    ];
  }

  // Build every row off-DOM, then swap them in as one operation. Appending rows
  // one at a time into the live container makes slower/older devices paint the
  // half-built room (and reflow per row), which reads as a join/spectate
  // flicker. A single fragment swap removes that intermediate state.
  const frag = document.createDocumentFragment();
  users.forEach((u) => createUserRow(u, frag));
  while (container.firstChild) container.removeChild(container.firstChild);
  container.appendChild(frag);
  // createUserRow's own visibility passes ran against the off-DOM fragment, so
  // re-run them now that the rows are live.
  adjustVoteButtonVisibility();
  adjustLayout();
  if (chatInput)
    setTimeout(() => {
      chatInput.focus();
      placeCursorAtEnd(chatInput);
    }, 0);
}

function getRoomTypeDisplay(type) {
  switch (type) {
    case "public":
      return "Public";
    case "semi-private":
      return "Semi-Private";
    case "private":
      return "Private";
    default:
      return type || "";
  }
}

function updateRoomInfo(data) {
  const nameEl = document.querySelector(".room-name");
  const uptimeEl = document.querySelector(".room-uptime");
  const idEl = document.querySelector(".room-id");
  const typeEl = document.querySelector(".room-type");

  if (nameEl)
    nameEl.textContent = `Room: ${currentRoomName || data.roomName || data.roomId}`;
  if (uptimeEl) uptimeEl.textContent = msToTime(Date.now() - data.createdAt);
  if (idEl) idEl.textContent = `Room ID: ${data.roomId || currentRoomId}`;

  // "room joined" sends roomType, "room update" sends type
  const roomType = data.roomType || data.type;
  if (typeEl && roomType) {
    typeEl.textContent = `${getRoomTypeDisplay(roomType) || "Public"} room`;
  }

  if (data.queue !== undefined) renderQueueChip(data.queue);
}

// ── Queue Chip (navbar, between the clock and the waffle menu) ─────────────
// Names are server-supplied usernames rendered via textContent - never trust
// them as markup.
let queueChipExpanded = false;
function renderQueueChip(queue) {
  const chip = document.getElementById("queueChip");
  if (!chip) return;
  const list = Array.isArray(queue) ? queue : [];

  if (list.length === 0) {
    chip.hidden = true;
    queueChipExpanded = false;
    chip.setAttribute("aria-expanded", "false");
    return;
  }

  chip.hidden = false;
  const countEl = chip.querySelector(".queue-chip-count");
  const namesEl = chip.querySelector(".queue-chip-names");
  if (countEl)
    countEl.textContent = `${list.length} waiting`;
  if (namesEl) namesEl.textContent = list.map((q) => q.username).join(", ");
  chip.setAttribute("aria-expanded", String(queueChipExpanded));
}

document.addEventListener("DOMContentLoaded", () => {
  const chip = document.getElementById("queueChip");
  if (chip) {
    chip.addEventListener("click", () => {
      queueChipExpanded = !queueChipExpanded;
      chip.setAttribute("aria-expanded", String(queueChipExpanded));
    });
  }
});

// ── 14. LAYOUT ──────────────────────────────────────────────────────────────

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.setAttribute("data-emote-styles", "true");
  style.textContent = `
    .emote { display:inline-block; vertical-align:middle; width:auto; height:20px; margin:0 2px; }
    .emote-stack { display:inline-grid; grid-template-areas:"stack"; align-items:center; justify-items:center; vertical-align:middle; margin:0 2px; line-height:0; }
    .emote-stack > .emote { grid-area:stack; margin:0; }
    .emote-overlay { margin:0; }
    .emote-autocomplete { position:absolute; z-index:10000; background:#333; border:1px solid #555; border-radius:4px; max-height:300px; overflow-y:auto; width:200px; box-shadow:0 3px 10px rgba(0,0,0,0.3); }
    .emote-autocomplete-header { padding:5px 10px; font-weight:bold; border-bottom:1px solid #555; color:#eee; }
    .emote-autocomplete-list { max-height:250px; overflow-y:auto; }
    .emote-autocomplete-item { display:flex; align-items:center; padding:8px 10px; cursor:pointer; border-bottom:1px solid #444; color:#fff; }
    .emote-autocomplete-item.selected, .emote-autocomplete-item:hover { background-color:#555; }
    .emote-autocomplete-item img { width:auto; height:20px; margin-right:10px; vertical-align:middle; }
    .votes-counter { display:inline-block; margin-left:10px; padding:2px 6px; background:#333; border-radius:4px; font-size:14px; transition:color 0.3s ease; }
    .vote-button { cursor:pointer; transition:background-color 0.2s ease; }
    .vote-button.voted { background-color:#5c3d3d !important; color:#ff9090 !important; }
    .votes-dropdown { position:fixed; z-index:100001; min-width:160px; max-width:240px; max-height:220px; overflow-y:auto; background:#000; border:1px solid #616161; border-radius:8px; padding:6px; box-shadow:0 6px 18px rgba(0,0,0,0.5); font-family:talkoSS, Arial, sans-serif; }
    .votes-dropdown-title { color:#ff9800; font-size:12px; padding:2px 6px 6px; border-bottom:1px solid #333; margin-bottom:4px; }
    .votes-dropdown-item { color:#fff; font-size:13px; padding:4px 6px; border-radius:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .votes-dropdown-item:hover { background:#333; }
    /* Link safety */
    .chat-link { color:#4da6ff; text-decoration:underline; cursor:pointer; word-break:break-all; }
    .chat-link:hover { color:#80c1ff; }
    .link-warning-overlay { display:none; position:fixed; inset:0; z-index:100000; background:rgba(0,0,0,0.8); align-items:center; justify-content:center; }
    .link-warning-overlay.show { display:flex; }
    .link-warning-box { background:#1a1a1a; border:2px solid #ff9800; border-radius:12px; max-width:440px; width:90%; padding:24px 28px; text-align:center; color:#ccc; font-size:14px; line-height:1.6; box-shadow:0 12px 40px rgba(0,0,0,0.6); }
    .link-warning-icon { font-size:40px; margin-bottom:6px; }
    .link-warning-title { color:#ff9800; font-size:18px; font-weight:bold; margin:6px 0 12px; }
    .link-warning-url { background:#000; border:1px solid #555; border-radius:6px; padding:8px 10px; margin:12px 0; color:#fff; word-break:break-all; font-family:monospace; font-size:13px; max-height:80px; overflow-y:auto; }
    .link-warning-note { color:#888; font-size:12px; margin-top:10px; }
    .link-warning-buttons { display:flex; gap:10px; justify-content:center; margin-top:18px; }
    .link-warning-back { background:#444; color:#fff; border:none; padding:10px 18px; border-radius:6px; cursor:pointer; font-weight:bold; }
    .link-warning-back:hover { background:#555; }
    .link-warning-visit { background:#ff9800; color:#000; border:none; padding:10px 18px; border-radius:6px; cursor:pointer; font-weight:bold; }
    .link-warning-visit:hover { background:#ffb74d; }
    /* Markdown-lite: code (colors match desk.js .dk-code-in/.dk-code-bl) */
    .chat-code-inline { font-family:"Courier New",monospace; font-size:14px; background:var(--tk-row-chat-bg-inv,var(--tk-chat-bg-inv,#000)); border:1px solid var(--tk-row-border,var(--tk-border,#333)); border-radius:3px; padding:0 4px; color:var(--tk-row-chat-text,var(--tk-chat-text,#ffb454)); word-break:break-word; }
    .chat-code-block { display:block; font-family:"Courier New",monospace; font-size:14px; background:var(--tk-row-chat-bg-inv,var(--tk-chat-bg-inv,#000)); border:1px solid var(--tk-row-border,var(--tk-border,#333)); border-radius:5px; padding:8px 10px; margin:4px 0; color:var(--tk-row-chat-text,var(--tk-chat-text,#ededed)); white-space:pre-wrap; word-break:break-word; max-height:180px; overflow:auto; }
    /* Image-link thumbnails */
    .chat-img-thumb { display:block; max-width:100%; max-height:96px; width:auto; height:auto; object-fit:contain; border-radius:4px; border:1px solid #616161; margin-top:4px; }

    /* Mobile: prefer dynamic viewport units where supported */
    @supports (height: 100dvh) {
      html, body { height: 100dvh; }
      .page-container { height: 100dvh; min-height: 100dvh; }
    }
  `;
  document.head.appendChild(style);

  refreshCodeBgToken();
  new MutationObserver(refreshCodeBgToken).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["style"],
  });
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  const full =
    clean.length === 3
      ? clean.split("").map((c) => c + c).join("")
      : clean;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return (
    "#" +
    [r, g, b]
      .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"))
      .join("")
  );
}

// Inverts a hex color in HSV space (hue +180, saturation and value
// flipped) so a derived color reliably contrasts with the source instead
// of being an unrelated fixed value.
function invertHsv(hex) {
  try {
    const [r, g, b] = hexToRgb(hex).map((n) => n / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    const v = max;
    const ih = (h + 180) % 360;
    const is = 1 - s;
    const iv = 1 - v;
    const c = iv * is;
    const x = c * (1 - Math.abs(((ih / 60) % 2) - 1));
    const m = iv - c;
    let rgb;
    if (ih < 60) rgb = [c, x, 0];
    else if (ih < 120) rgb = [x, c, 0];
    else if (ih < 180) rgb = [0, c, x];
    else if (ih < 240) rgb = [0, x, c];
    else if (ih < 300) rgb = [x, 0, c];
    else rgb = [c, 0, x];
    return rgbToHex(rgb.map((n) => (n + m) * 255));
  } catch {
    return null;
  }
}

// Chat code has no dedicated background token - it derives one from the
// HSV-inverted chat text color so it always contrasts with whatever the
// room theme sets, instead of following an unrelated/fixed color.
function refreshCodeBgToken() {
  const root = document.documentElement;
  const text = getComputedStyle(root).getPropertyValue("--tk-chat-text").trim() || "#ffa500";
  const inv = invertHsv(text);
  if (inv && root.style.getPropertyValue("--tk-chat-bg-inv") !== inv) {
    root.style.setProperty("--tk-chat-bg-inv", inv);
  }
}

function isMobile() {
  return window.innerWidth <= 768;
}

// On mobile, the collapsing URL bar and on-screen keyboard change
// visualViewport.height without a matching change to window.innerHeight,
// which left a dead white strip at the bottom. Desktop is unchanged since
// the two values match there.
function getAvailableViewportHeight() {
  if (
    window.visualViewport &&
    typeof window.visualViewport.height === "number"
  ) {
    return window.visualViewport.height;
  }
  return window.innerHeight;
}

function adjustLayout() {
  injectStyles();
  const container = document.querySelector(".chat-container");
  const rows = document.querySelectorAll(".chat-row");
  if (!container || rows.length === 0) return;

  const activeEl = document.activeElement;
  let activeUserId = null;
  if (activeEl?.classList.contains("chat-input")) {
    activeUserId = activeEl.closest(".chat-row")?.dataset.userId;
  }

  // Mobile is always horizontal. On desktop the user's local toggle (if they
  // flipped it) wins over the room's layout; otherwise the room's layout is used.
  const layout = isMobile()
    ? "horizontal"
    : userLayoutPreference || currentRoomLayout;

  // Reset styles that only the crowd grid sets, so the <=4 layouts below are
  // never affected by a previous larger headcount.
  container.style.flexWrap = "";
  container.style.alignContent = "";
  container.style.height = "";
  container.style.overflowY = "";
  rows.forEach((row) => (row.style.flex = ""));

  if (rows.length > 4) {
    // Crowd mode: balanced grid (columns x rows) that fills the room. Column
    // count follows the layout preference and the available width; it only
    // scrolls if cells would otherwise get too short. The <=4 cases are
    // left exactly as they were.
    container.style.flexDirection = "row";
    container.style.flexWrap = "wrap";
    container.style.alignContent = "flex-start";
    const GAP = 5; // matches the .chat-container gap
    // Use the container's REAL inner box (its flex height already excludes the
    // navbars and the invite bar below it) so the bottom row is never clipped.
    const cs = getComputedStyle(container);
    const hpad =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const vpad =
      (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    let cw = container.clientWidth - hpad;
    const target = layout === "horizontal" ? 340 : 210;
    const maxCols = layout === "horizontal" ? 3 : 5;
    let cols = Math.floor((cw + GAP) / (target + GAP));
    cols = Math.max(2, Math.min(maxCols, cols, rows.length));
    const gridRows = Math.ceil(rows.length / cols);
    const availH = container.clientHeight - vpad;
    const idealH = Math.floor((availH - (gridRows - 1) * GAP) / gridRows);
    const cellH = Math.max(120, idealH);
    const scroll = cellH > idealH;
    container.style.overflowY = scroll ? "auto" : "hidden";
    if (scroll) cw -= 16; // leave room for the scrollbar
    const cellW = Math.floor((cw - (cols - 1) * GAP) / cols);
    rows.forEach((row) => {
      const collapsed = row.classList.contains("bot-muted");
      const ui = row.querySelector(".user-info");
      const iw = row.querySelector(".chat-input-wrapper");
      row.style.flex = "0 0 auto";
      row.style.width = `${cellW}px`;
      // Crowd mode keeps the grid's column/row balancing untouched (it's
      // already many small tiles) - a collapsed bot just shrinks to its own
      // header height in place rather than reflowing the whole grid.
      row.style.height = collapsed && ui ? `${ui.offsetHeight}px` : `${cellH}px`;
      row.style.minHeight = "0";
      if (ui && iw) iw.style.height = collapsed ? "0px" : `${cellH - ui.offsetHeight - 2}px`;
    });
  } else if (layout === "horizontal") {
    container.style.flexDirection = "column";
    const containerTop = container.getBoundingClientRect().top;
    const avail = getAvailableViewportHeight() - containerTop;
    const gap = (rows.length - 1) * 10;
    const collapsedRows = [...rows].filter((row) => row.classList.contains("bot-muted"));
    const activeRows = [...rows].filter((row) => !row.classList.contains("bot-muted"));
    // If every row is a muted bot there's nothing to reclaim space for -
    // fall back to the original even split rather than shrinking everything.
    const hasActive = activeRows.length > 0 && activeRows.length < rows.length;
    const collapsedTotal = collapsedRows.reduce(
      (sum, row) => sum + (row.querySelector(".user-info")?.offsetHeight || 0),
      0,
    );
    const activeH = hasActive
      ? Math.floor((avail - gap - collapsedTotal) / activeRows.length)
      : Math.floor((avail - gap) / rows.length);
    rows.forEach((row) => {
      const collapsed = hasActive && row.classList.contains("bot-muted");
      const ui = row.querySelector(".user-info");
      const iw = row.querySelector(".chat-input-wrapper");
      const h = collapsed && ui ? ui.offsetHeight : activeH;
      row.style.height = `${h}px`;
      row.style.minHeight = collapsed ? "0" : "100px";
      row.style.width = "100%";
      iw.style.height = collapsed ? "0px" : `${h - ui.offsetHeight - 2}px`;
    });
  } else {
    container.style.flexDirection = "row";
    const avail = container.offsetWidth;
    const gap = (rows.length - 1) * 10;
    const COLLAPSED_WIDTH = 90;
    const collapsedRows = [...rows].filter((row) => row.classList.contains("bot-muted"));
    const activeRows = [...rows].filter((row) => !row.classList.contains("bot-muted"));
    const hasActive = activeRows.length > 0 && activeRows.length < rows.length;
    const collapsedTotal = collapsedRows.length * COLLAPSED_WIDTH;
    const activeW = hasActive
      ? Math.floor((avail - gap - collapsedTotal) / activeRows.length)
      : Math.floor((avail - gap) / rows.length);
    rows.forEach((row) => {
      const collapsed = hasActive && row.classList.contains("bot-muted");
      const w = collapsed ? COLLAPSED_WIDTH : activeW;
      row.style.width = `${w}px`;
      row.style.height = "100%";
      const ui = row.querySelector(".user-info");
      const iw = row.querySelector(".chat-input-wrapper");
      iw.style.height = collapsed ? "0px" : `calc(100% - ${ui.offsetHeight}px - 2px)`;
    });
  }

  // Don't touch room-chat focus while the Talkoboard is open. The board and its
  // own chat box own focus then, so refocusing the hidden room input here would
  // yank focus away mid-type (which is what a join/leave was doing to the
  // Talkoboard chat box).
  if (activeUserId && !talkoboardInstance?.isOpen) {
    const el = document.querySelector(
      `.chat-row[data-user-id="${activeUserId}"] .chat-input`,
    );
    if (el) setTimeout(() => el.focus(), 0);
  }

  // Box heights just changed (resize, layout toggle, bot collapse/expand) -
  // re-check whether each other-user box still overflows and is followed.
  document
    .querySelectorAll(".chat-row:not(.current-user) .chat-input")
    .forEach(updateChatScrollIndicator);

  refreshLayoutToggle();
}

// The layout toggle only makes sense on desktop in a small room. Past 4 users
// the room switches to the crowd grid, so the toggle is removed; it comes back
// the moment the room drops to 4 or fewer. Also keeps the icon and tooltip in
// sync with whichever layout is actually on screen.
function refreshLayoutToggle() {
  const btn = document.getElementById("layoutToggle");
  if (!btn) return;
  const userCount = document.querySelectorAll(".chat-row").length;
  const show = !isMobile() && userCount > 0 && userCount <= 4;
  btn.style.display = show ? "flex" : "none";
  if (!show) return;
  const horizontal =
    (userLayoutPreference || currentRoomLayout) === "horizontal";
  const icon = btn.querySelector("i");
  if (icon)
    icon.className = horizontal ? "fas fa-bars" : "fas fa-table-columns";
  btn.title = horizontal
    ? "Layout: Horizontal (click to switch to vertical)"
    : "Layout: Vertical (click to switch to horizontal)";
}

// Flip this user's local view between horizontal and vertical, then re-render.
// Purely client-side: no socket event, so only this screen changes.
function toggleRoomLayout() {
  const current = userLayoutPreference || currentRoomLayout;
  userLayoutPreference = current === "horizontal" ? "vertical" : "horizontal";
  adjustLayout();
}

function handleViewportChange() {
  const vp = document.querySelector("meta[name=viewport]");
  if (window.visualViewport) {
    // -1 tolerates sub-pixel rounding so the keyboard branch only fires
    // when the keyboard or URL bar is genuinely eating space
    if (window.visualViewport.height < window.innerHeight - 1) {
      if (vp)
        vp.setAttribute(
          "content",
          "width=device-width, initial-scale=1, maximum-scale=1",
        );
      document.body.style.height = `${window.visualViewport.height}px`;
    } else {
      if (vp) vp.setAttribute("content", "width=device-width, initial-scale=1");
      // Clear the inline override so the dvh rule applies instead
      document.body.style.height = "";
    }
  }
  adjustLayout();
}

// ── 15. DATE/TIME ────────────────────────────────────────────────────────────

const dateTimeElement = document.querySelector("#dateTime");
function updateTimeLabels() {
  const now = new Date();
  dateTimeElement.querySelector(".date").textContent = now.toLocaleDateString(
    "en-US",
    { weekday: "long", year: "numeric", month: "short", day: "numeric" },
  );
  dateTimeElement.querySelector(".time").textContent = now.toLocaleTimeString();

  const uptimeEl = document.querySelector(".room-uptime");
  if (uptimeEl) {
    uptimeEl.textContent = currentRoomCreatedAt > 0 ? msToTime(Date.now() - currentRoomCreatedAt) : "";
  }
}

function msToTime(duration) {
  const seconds = parseInt((duration / 1000) % 60),
    minutes = parseInt((duration / (1000 * 60)) % 60),
    hours = parseInt((duration / (1000 * 60 * 60))); // no modulo here. max res is hrs

  return (hours > 0 ? hours + ":" : "") + String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
}

// ── 16. SOCKET EVENT HANDLERS ───────────────────────────────────────────────

socket.on("chat update", displayChatMessage);

socket.on("update votes", updateVotesUI);

socket.on("update mute votes", updateMuteVotesUI);

socket.on("kicked", (data) => {
  showInfoModal(
    (data && data.message) ||
    "You have been removed from the room by a majority vote.",
    () => {
      window.location.href = "/index.html";
    },
  );
});

socket.on("room joined", (data) => {
  // Protocol gate: if the server speaks a different message version than the JS
  // we are running, a breaking deploy happened under us. Reload once (guarded
  // so a stale cache can't loop) to pick up the matching client. A matching
  // protocol means the restart is invisible and we just rejoin below.
  if (data.protocol != null && data.protocol !== CLIENT_PROTOCOL) {
    if (!sessionStorage.getItem("tkProtoReload")) {
      sessionStorage.setItem("tkProtoReload", "1");
      window.location.reload();
      return;
    }
  } else {
    sessionStorage.removeItem("tkProtoReload");
  }

  // A queue promotion lands here too (the server sends a normal "room joined"
  // right after "queue promoted") - drop the read-only banner and re-enable
  // the chat input.
  if (isSpectating) {
    isSpectating = false;
    document.getElementById("spectateBanner")?.remove();
  }

  currentUserId = data.userId;
  currentRoomId = data.roomId;
  currentUsername = data.username;
  currentLocation = data.location;
  currentRoomLayout = data.layout || currentRoomLayout;
  currentRoomName = data.roomName;
  currentRoomMaxSize = data.maxSize || 0;
  currentRoomCreatedAt = data.createdAt || 0;

  currentUserIsDev = !!data.isDev;
  currentUserIsMod = !!data.isMod;
  currentUserModLevel = data.modLevel || 0;
  currentUserIsHidden = !!data.isHidden;
  currentUserIsVanished = !!data.isVanished;

  updateRoomInfo(data);
  updateRoomUI(data);
  if (data.votes) updateVotesUI(data.votes);
  if (data.muteVotes || data.mutedBotIds) updateMuteVotesUI(data);
  if (data.currentMessages) updateCurrentMessages(data.currentMessages);

  // Re-broadcast this user's chat panel style (border/bg/text) - the server
  // drops it when the user leaves, so after a rejoin or reload the rest of the
  // room needs it re-asserted. Our own row already renders it without waiting
  // for the echo (see resolvePanelStyle).
  const savedPanelStyle = loadSavedPanelStyle();
  if (savedPanelStyle) socket.emit("set panel style", savedPanelStyle);

  // Appearance controls (hide/vanish/color) now live inside the Staff panel,
  // so the navbar only gains a single "Staff" button - keeps mobile tidy.
  if (currentUserIsDev) {
    if (!currentUserIsHidden) triggerDevConfetti();
    const savedColor = localStorage.getItem("talkomatic_devColor");
    if (savedColor) {
      socket.emit("dev set color", { color: savedColor });
      applyDevColor(savedColor);
    }
  }

  // Re-apply the saved hide-flair preference for staff (dev or mod). The server
  // restores it from the session when it can, but a restart wipes the session,
  // so we re-assert from localStorage on every join. The server confirms via
  // "dev hide status", which fixes the row, button, and re-saves the choice.
  if (currentUserIsDev || currentUserIsMod) {
    const savedHidden = localStorage.getItem("talkomatic_devHidden");
    if (savedHidden === "1" && !currentUserIsHidden) {
      socket.emit("dev set hide", { isHidden: true });
    } else if (savedHidden === "0" && currentUserIsHidden) {
      socket.emit("dev set hide", { isHidden: false });
    }
  }

  if (isStaff()) createStaffPanelButton();
  applyRoomFlags(data);

  renderDevContext();

  // After a server restart we rejoin a room the server rehydrated from disk,
  // but our typed text only lived in memory and is gone server-side (and
  // updateCurrentMessages just blanked our row). Re-render it locally and push
  // it back so the whole room sees it again. pendingRestoreText was captured at
  // reconnect time, before this handler ran.
  if (pendingRestoreText) {
    const restore = pendingRestoreText;
    pendingRestoreText = null;
    if (restore && currentUserId) {
      updateCurrentMessages({ [currentUserId]: restore });
      socket.emit("chat update", {
        diff: { type: "full-replace", text: restore },
      });
    }
  }

  // Back in the room for real, so close any reconnect/updating overlay.
  if (window.TalkomaticConnection) window.TalkomaticConnection.recovered();

  setTimeout(() => {
    if (chatInput) {
      chatInput.focus();
      placeCursorAtEnd(chatInput);
    }
  }, 100);
});

socket.on("room not found", () => {
  showInfoModal(
    "Something went wrong finding the room. Taking you back to sign in.",
    () => {
      window.location.href = "/index.html";
    },
  );
});

socket.on("user joined", (data) => {
  const c = document.querySelector(".chat-container");
  if (!c) return;

  // A row can already exist here if an earlier "user left" for this same
  // userId never arrived (dropped over the network, a transport hiccup) -
  // rebuilding unconditionally, rather than no-op'ing when one's found,
  // guarantees a rejoin always shows blank instead of getting stuck with
  // whatever stale text that missed removal left behind.
  const existingRow = document.querySelector(
    `.chat-row[data-user-id="${data.id}"]`,
  );
  if (existingRow) existingRow.remove();

  const row = createUserRow(data, c);
  // A ghost's last text survives its rejoin (server-side buffer never got
  // cleared - see leaveRoom's ghost branch), and our own "room joined" already
  // shows it via currentMessages. Apply it here too so every OTHER client's
  // freshly-built row for them starts in sync instead of sitting blank.
  if (data.text) {
    renderOtherUserMessage(row.querySelector(".chat-input"), data.text);
  }
  adjustLayout();
  updateRoomInfo(data);
  if (notificationsEnabled && document.hidden) showTabDot();

  // A new join can cross the voting threshold
  updateVotesUI(currentVotes);

  // Confetti only on the dev's own screen
  if (data.isDev && !data.isHidden && currentUserIsDev) {
    triggerDevConfetti();
  }
  // No explicit refocus here: adjustLayout() already restores focus to the
  // chat input only when it was active, so a join never steals focus from a
  // dev's open modal (or pops the mobile keyboard when you're not typing).
});

socket.on("user left", (userId) => {
  if (userId !== currentUserId) {
    const row = document.querySelector(`.chat-row[data-user-id="${userId}"]`);
    if (row) {
      row.remove();
      adjustLayout();
      if (notificationsEnabled && document.hidden) showTabDot();

      // Dropping below the voting minimum must clean up vote UI immediately
      adjustVoteButtonVisibility();
      updateVotesUI(currentVotes);
    }
  }
});

socket.on("queue update", (data) => renderQueueChip(data?.queue));

socket.on("room update", (roomData) => {
  currentRoomLayout = roomData.layout || currentRoomLayout;
  applyRoomFlags(roomData);
  updateRoomInfo(roomData);
  const activeEl = document.activeElement;
  const saved = new Map();

  document.querySelectorAll(".chat-row").forEach((row) => {
    const uid = row.dataset.userId;
    const ci = row.querySelector(".chat-input");
    if (ci) {
      if (uid === currentUserId) {
        saved.set(uid, selfRawText);
      } else {
        saved.set(
          uid,
          ci.dataset.rawText !== undefined
            ? ci.dataset.rawText
            : getPlainText(ci),
        );
      }
    }
  });

  const existing = new Set();
  document
    .querySelectorAll(".chat-row")
    .forEach((r) => existing.add(r.dataset.userId));
  if (roomData.users) {
    const c = document.querySelector(".chat-container");
    roomData.users.forEach((u) => {
      if (!existing.has(u.id)) createUserRow(u, c);
    });
  }
  const current = new Set(roomData.users.map((u) => u.id));
  document.querySelectorAll(".chat-row").forEach((r) => {
    if (!current.has(r.dataset.userId) && r.dataset.userId !== currentUserId)
      r.remove();
  });

  // Refresh dev appearance on existing rows
  if (roomData.users) {
    roomData.users.forEach((u) => {
      const row = document.querySelector(`.chat-row[data-user-id="${u.id}"]`);
      if (!row) return;
      applyDevAppearanceToRow(row, u);
      applyPanelStyleToRow(row, u);
      syncUserRowNote(row, u);

      // Ghost toggle: a fresh departure marks an existing row without
      // recreating it; a reconnect reclaiming their own seat un-marks it the
      // same way.
      const wasDeparted = row.classList.contains("departed");
      const isDeparted = !!u.departed;
      if (wasDeparted !== isDeparted) {
        row.classList.toggle("departed", isDeparted);
        const info = row.querySelector(".user-info");
        const existingLabel = info?.querySelector(".departed-label");
        if (isDeparted && info && !existingLabel) {
          const leftLabel = document.createElement("span");
          leftLabel.className = "departed-label";
          leftLabel.textContent = "left";
          info.appendChild(leftLabel);
        } else if (!isDeparted && existingLabel) {
          existingLabel.remove();
        }
      }
    });
  }

  if (currentUserIsDev) refreshCurrentUserAppearance();

  saved.forEach((rawVal, uid) => {
    const ci = document.querySelector(
      `.chat-row[data-user-id="${uid}"] .chat-input`,
    );
    if (!ci) return;
    if (uid === currentUserId) {
      // If you're actively typing in your own box, leave it completely alone.
      // Rebuilding the DOM here is what was jumping the caret when someone
      // joined. Your local input is already the source of truth.
      selfRawText = rawVal;
      const typingHere =
        activeEl?.classList.contains("chat-input") &&
        activeEl.closest(".chat-row")?.dataset.userId === uid;
      if (typingHere) return;
      selfIsFiltered = wordFilterEnabled && clientWordFilter?.ready;
      renderOtherUserMessage(ci, rawVal);
    } else {
      renderOtherUserMessage(ci, rawVal);
    }
  });

  // Re-render vote UI after the row set may have changed
  adjustVoteButtonVisibility();
  updateVotesUI(roomData.votes || currentVotes);
  updateMuteVotesUI({
    muteVotes: roomData.muteVotes || currentMuteVotes,
    mutedBotIds: roomData.mutedBotIds || Array.from(mutedBotIds),
  });
  adjustLayout();

  renderDevContext();
});

socket.on("access code required", () => {
  showInputModal(
    "Access Code Required",
    "Please enter the 6-digit access code for this room:",
    {
      placeholder: "6-digit code",
      maxLength: "6",
      validate: (v) =>
        !v
          ? "Access code is required"
          : v.length !== 6 || !/^\d+$/.test(v)
            ? "Invalid code."
            : true,
    },
    (confirmed, code) => {
      if (confirmed && code) joinRoom(currentRoomId, code);
      else
        showInfoModal("Taking you back to sign in.", () => {
          window.location.href = "/index.html";
        });
    },
  );
});

socket.on("room closed", (data) => {
  showInfoModal(data.message ?? "This room was closed.", () => {
    window.location.href = data.redirectTo ?? "/";
  });
});

socket.on("error", (error) => {
  console.log(error);
  showErrorModal(
    (error.error.replaceDefaultText ? "" : "An error occurred: ") +
    error.error.message,
  );
});

socket.on("dev kick success", (data) => {
  console.log(`[DEV] Kicked "${data.targetUsername}" from "${data.roomName}"`);
});

// ── 17. INITIALIZATION ──────────────────────────────────────────────────────

// Discord avatar helpers (mirror of the lobby's): the URL is only ever built
// from a validated snowflake id + CDN hash, never taken from data directly.
const PFP_ID_RE = /^\d{17,20}$/;
const PFP_HASH_RE = /^(?:a_)?[a-f0-9]{32}$/i;

function discordAvatarUrl(av, size) {
  if (!av) return null;
  const id = av.discordId || av.id;
  if (!PFP_ID_RE.test(id || "") || !PFP_HASH_RE.test(av.hash || "")) return null;
  return (
    "https://cdn.discordapp.com/avatars/" + id + "/" + av.hash +
    ".webp?size=" + (size || 64) + (av.animated ? "&animated=true" : "")
  );
}

function storedAvatar() {
  try {
    if (localStorage.getItem("talkomaticPfpEnabled") !== "1") return null;
    const c = JSON.parse(localStorage.getItem("talkomaticPfp") || "null");
    if (c && PFP_ID_RE.test(c.discordId) && PFP_HASH_RE.test(c.hash))
      return { discordId: c.discordId, hash: c.hash, animated: !!c.animated };
  } catch (e) {}
  return null;
}

// There is no separate sign-in page any more, so a first-time visitor is
// asked for a name right here, once. This is a real in-page overlay rather
// than window.prompt(): Chrome silently suppresses prompt()/alert()/confirm()
// when the tab isn't the focused, active one at the moment the call fires -
// no dialog, no error, just an instant null - which would otherwise pass
// unnoticed straight into a "declined" fallback. Also reused by "Change name".
const nameEntryModal = document.getElementById("nameEntryModal");
const nameEntryInput = document.getElementById("nameEntryInput");
const nameEntryError = document.getElementById("nameEntryError");
const nameEntryConfirmBtn = document.getElementById("nameEntryConfirmBtn");

function askForName(existingName) {
  return new Promise((resolve) => {
    nameEntryInput.value = existingName || "";
    nameEntryError.style.display = "none";
    nameEntryError.textContent = "";
    nameEntryModal.classList.add("show");
    document.body.style.overflow = "hidden";
    nameEntryInput.focus();

    const submit = () => {
      const typed = nameEntryInput.value.trim().slice(0, 15);
      if (!typed) {
        nameEntryError.textContent = "Please enter a name.";
        nameEntryError.style.display = "block";
        return;
      }
      nameEntryModal.classList.remove("show");
      document.body.style.overflow = "";
      nameEntryConfirmBtn.removeEventListener("click", submit);
      nameEntryInput.removeEventListener("keydown", onKeydown);
      resolve(typed);
    };
    const onKeydown = (e) => {
      if (e.key === "Enter") submit();
    };
    nameEntryConfirmBtn.addEventListener("click", submit);
    nameEntryInput.addEventListener("keydown", onKeydown);
  });
}

// "Change name" button: reopens the same overlay pre-filled, then reloads so
// the room-join sequence runs fresh with the new name rather than trying to
// rename a live seat in place.
async function changeName() {
  const current =
    currentUsername || localStorage.getItem("talkomaticUsername") || "";
  const typed = await askForName(current);
  if (typed === current) return;
  localStorage.setItem("talkomaticUsername", typed);
  window.location.reload();
}

async function joinRoom(roomId, accessCode = null) {
  // Re-announce identity from this browser before joining. "join room" carries
  // no name and trusts the server session, but the session is in-memory: a
  // server restart wipes it (the signed cookie survives, its data does not), so
  // a plain join after a restart - or any full page load with a lost session,
  // such as a hard refresh or the reload after being granted mod - would land
  // as "Anonymous" / "On The Web". This self-heals from localStorage; a
  // first-ever visit (nothing in localStorage yet) asks for a name instead.
  // Mirrors the reconnect path below: announce, then join once the sign-in is
  // acknowledged (with a timeout fallback so a missed ack never strands the join).
  let uname = currentUsername || localStorage.getItem("talkomaticUsername");
  const uloc =
    currentLocation ||
    localStorage.getItem("talkomaticLocation") ||
    "On The Web";

  if (!uname) {
    uname = await askForName();
    localStorage.setItem("talkomaticUsername", uname);
    localStorage.setItem("talkomaticLocation", uloc);
    currentUsername = uname;
    currentLocation = uloc;
  }

  let joined = false;
  const doJoin = () => {
    if (joined) return;
    joined = true;
    socket.emit("join room", { roomId, accessCode });
  };
  const announceThenJoin = () => {
    socket.once("signin status", doJoin);
    setTimeout(doJoin, 1500);
    socket.emit("join lobby", {
      username: uname,
      location: uloc,
      avatar: storedAvatar(),
    });
  };

  if (socket.connected) announceThenJoin();
  else socket.once("connect", announceThenJoin);
}

// On reconnect (an idle/backgrounded tab that dropped, or a server restart)
// get the user back into their room with no manual step. Without this we become
// a ghost: still in the room on our own screen, but gone for everyone else, and
// our typing reaches no one. Spectators re-spectate.
//
// A plain network blip keeps the server's session, so a bare rejoin works and
// semi-private access stays valid via the session. A server restart wipes the
// in-memory session, so the rejoin would otherwise land as "Anonymous": we
// first re-announce identity through the normal sign-in ("join lobby", which
// re-validates the name and the reserved-name/key rule), then rejoin once it is
// set. Doing this on every reconnect is harmless and keeps the path simple.
socket.io.on("reconnect", () => {
  if (tabSuperseded || !currentRoomId) return;
  if (isSpectating) {
    socket.emit("spectate room", { roomId: currentRoomId });
    return;
  }

  // Capture typed text now, before "room joined" / updateCurrentMessages can
  // blank our row, so it can be re-pushed after a restart forgot our buffer.
  pendingRestoreText =
    (typeof selfRawText === "string" && selfRawText) || lastSentMessage || null;

  const uname = currentUsername || localStorage.getItem("talkomaticUsername");
  const uloc =
    currentLocation ||
    localStorage.getItem("talkomaticLocation") ||
    "On The Web";

  if (!uname) {
    // No identity to restore (shouldn't happen on an established room page);
    // fall back to the bare rejoin.
    socket.emit("join room", { roomId: currentRoomId });
    return;
  }

  // Rejoin once the sign-in is acknowledged. The timeout is a fallback so a
  // missed ack never strands the reconnect on the "updating" overlay.
  let rejoined = false;
  const doJoin = () => {
    if (rejoined) return;
    rejoined = true;
    socket.emit("join room", { roomId: currentRoomId });
  };
  socket.once("signin status", doJoin);
  setTimeout(doJoin, 1500);
  socket.emit("join lobby", {
    username: uname,
    location: uloc,
    avatar: storedAvatar(),
  });
});

// Reads roomId from the URL and scrubs any legacy ?accessCode= parameter
// from the address bar and browser history. There is only one room, so a
// missing ?roomId= just means "the" room rather than an error.
const MAIN_ROOM_ID = "000001";
function readAndScrubUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get("roomId") || MAIN_ROOM_ID;
  const accessCode = params.get("accessCode"); // legacy fallback only

  if (accessCode !== null) {
    params.delete("accessCode");
    const query = params.toString();
    const cleanUrl = window.location.pathname + (query ? `?${query}` : "");
    try {
      history.replaceState(null, "", cleanUrl);
    } catch {
      // history API unavailable, join still works
    }
  }

  return { roomId, accessCode };
}

async function initRoom() {
  const filter = new ClientWordFilter();
  // Emotes come from an external host - kick off the load but never block (or
  // delay) entering the room on it; it populates emoteList in the background.
  // The word filter is same-origin and fast, so we still await it before joining.
  loadEmotes();
  await filter.init();
  if (filter.ready) clientWordFilter = filter;
  else console.warn("[WordFilter] Not available.");

  const { roomId, accessCode } = readAndScrubUrlParams();
  const spectate =
    new URLSearchParams(window.location.search).get("spectate") === "1";

  if (roomId) {
    currentRoomId = roomId;
    if (spectate) {
      // Staff (dev or mod) read-only watch; the server validates the key.
      isSpectating = true;
      socket.emit("spectate room", { roomId });
    } else {
      joinRoom(roomId, accessCode);
    }
  } else {
    showInfoModal("Something went wrong. Taking you back to sign in.", () => {
      window.location.href = "/index.html";
    });
  }
}

window.addEventListener("load", () => {
  injectStyles();
  initRoom();
  updateTimeLabels();
  adjustLayout();
  initializeAppDirectory();

  // Tab notifications
  const savedNotify = localStorage.getItem("notificationsEnabled");
  if (savedNotify !== null) {
    notificationsEnabled = JSON.parse(savedNotify);
    updateNotifyIcon();
  }
  notifyToggleButton.addEventListener("click", toggleNotifications);

  // Layout toggle (desktop, client-side view preference). Shown only at <=4
  // users; refreshLayoutToggle() handles when it appears/disappears.
  const layoutBtn = document.getElementById("layoutToggle");
  if (layoutBtn) layoutBtn.addEventListener("click", toggleRoomLayout);

  const changeNameBtn = document.getElementById("changeNameToggle");
  if (changeNameBtn) changeNameBtn.addEventListener("click", changeName);

  // Viewport: immediate handler so the mobile keyboard reflows without lag
  if (window.visualViewport)
    window.visualViewport.addEventListener("resize", handleViewportChange);

  // Link safety (delegated click handler + warning popup)
  initLinkSafety();

  // Ensure autocomplete element exists
  if (!document.getElementById("emoteAutocomplete")) {
    const el = document.createElement("div");
    el.id = "emoteAutocomplete";
    el.className = "emote-autocomplete";
    el.style.display = "none";
    document.body.appendChild(el);
    emoteAutocomplete = el;
  }
});

// One active tab per browser session. If another tab takes over this identity,
// pause this tab with a clear notice rather than letting the two fight over one
// identity (which crossed names and typed messages between tabs).
let tabSuperseded = false;
function showTabSupersededOverlay() {
  if (tabSuperseded) return;
  tabSuperseded = true;
  try {
    socket.io.opts.reconnection = false;
    socket.disconnect();
  } catch (_) { }
  if (!document.getElementById("supersededStyles")) {
    const st = document.createElement("style");
    st.id = "supersededStyles";
    st.textContent = `
      #supersededOverlay{position:fixed;inset:0;z-index:1000002;background:#0a0a0a;
        display:flex;align-items:center;justify-content:center;padding:20px;font-family:Arial,sans-serif;}
      #supersededOverlay .ss-card{max-width:460px;width:100%;background:#181818;border:1px solid #616161;
        border-radius:10px;padding:36px 30px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.6);}
      #supersededOverlay .ss-icon{font-size:52px;color:#ff9800;margin-bottom:16px;}
      #supersededOverlay h1{color:#ff9800;font-size:24px;margin:0 0 10px;}
      #supersededOverlay p{color:#dddddd;font-size:15px;line-height:1.6;margin:0 0 22px;}
      #supersededOverlay button{background:#ff9800;color:#000;border:none;border-radius:6px;
        padding:12px 26px;font-size:15px;font-weight:bold;cursor:pointer;font-family:inherit;}
      #supersededOverlay button:hover{background:#ffb74d;}
    `;
    document.head.appendChild(st);
  }
  const ov = document.createElement("div");
  ov.id = "supersededOverlay";
  ov.innerHTML =
    '<div class="ss-card">' +
    '<div class="ss-icon"><i class="fas fa-window-restore"></i></div>' +
    "<h1>This tab is paused</h1>" +
    "<p>Talkomatic is now open in another tab. Only one tab can be active at a time, so this one was paused.</p>" +
    '<button id="ssUseHere">Use this tab</button>' +
    "</div>";
  document.body.appendChild(ov);
  const btn = document.getElementById("ssUseHere");
  if (btn) btn.addEventListener("click", () => window.location.reload());
}
socket.on("session superseded", showTabSupersededOverlay);

// Window resize runs ONE debounced layout pass (the visualViewport listener
// above stays immediate for keyboard responsiveness)
let viewportDebounceTimer = null;
function debouncedViewportChange() {
  if (viewportDebounceTimer) clearTimeout(viewportDebounceTimer);
  viewportDebounceTimer = setTimeout(() => {
    viewportDebounceTimer = null;
    handleViewportChange();
  }, 100);
}

setInterval(updateTimeLabels, 1000);
window.addEventListener("resize", debouncedViewportChange);

// ════════════════════════════════════════════════════════════════════════════
// 18. STAFF UI (mod + dev) - built on the shared StaffUI kit. The server
// validates role + hierarchy on every action; this layer is presentation only.
// ════════════════════════════════════════════════════════════════════════════

let currentRoomLocked = false;
let currentRoomSlow = false;
let currentRoomSpotlight = false;
let currentRoomMaxSize = 0; // effective capacity of the current room (0 = default)
let hudInterval = null;
let partyHornAudio = null;

function notify(message, type, opts) {
  if (window.StaffUI)
    window.StaffUI.toast(
      message,
      Object.assign({ type: type || "info" }, opts || {}),
    );
  else console.log("[staff]", message);
}

function staffRole() {
  if (currentUserIsDev) return "dev";
  return currentUserModLevel >= 2 ? "mod" : "jr";
}

function createModBadge(level) {
  const lvl = level === 1 ? 1 : 2;
  const badge = document.createElement("span");
  badge.className = lvl === 1 ? "mod-badge mod-badge-jr" : "mod-badge";
  badge.textContent = lvl === 1 ? "JR MOD" : "MOD";
  badge.title = lvl === 1 ? "Junior Moderator (L1)" : "Moderator (L2)";
  badge.dataset.level = String(lvl);
  return badge;
}

// Small dev-only marker shown next to a staffer who is hidden or vanished from
// normal users. The server sends the isHidden/isVanished flags only to devs, so
// this never reaches a regular viewer.
function makeStaffConcealedMarker(user) {
  const span = document.createElement("span");
  span.className = "staff-concealed-marker";
  const states = [];
  if (user.isVanished) states.push("vanished");
  if (user.isHidden) states.push("hidden");
  span.dataset.state = states.join("+");
  span.title = "Staff " + states.join(" + ");
  const icon = document.createElement("i");
  icon.className = user.isVanished ? "fas fa-ghost" : "fas fa-eye-slash";
  span.appendChild(icon);
  return span;
}

async function openUserNoteDialog(user, { viewOnly = true } = {}) {
  const name = user.username || "user";
  const currentNote = typeof user.note === "string" ? user.note : "";
  if (!window.StaffUI) {
    const msg = currentNote || "No note on file.";
    window.alert(`Note for ${name}:\n\n${msg}`);
    return;
  }
  if (viewOnly) {
    StaffUI.alert(
      `Note for ${name}`,
      currentNote || "No note on file.",
      '<i class="fas fa-sticky-note"></i>',
    );
    return;
  }
  const r = await StaffUI.prompt({
    title: `Note for ${name}`,
    icon: '<i class="fas fa-sticky-note"></i>',
    fields: [
      {
        name: "value",
        label: "Note message",
        type: "textarea",
        value: currentNote,
        placeholder: "This user was promoting unsafe websites...",
        maxLength: 1000,
      },
    ],
    confirmText: "Save note",
  });
  if (r != null) socket.emit("staff note", { targetUserId: user.id, message: r });
}

// ── Per-user staff menu ──────────────────────────────────────────────────────
function openUserStaffMenu(user) {
  if (!window.StaffUI) return;
  const name = user.username || "user";
  // Junior (level 1) mods handle what is on screen: wipe text, reset a name or
  // location, turn a picture off, warn, and kick. Full (level 2) mods add the
  // things that outlast the room - room bans and IP blocks. The server enforces
  // this on every action regardless of what this menu shows.
  const isFullMod =
    currentUserIsDev || (currentUserIsMod && currentUserModLevel >= 2);
  // Grouped so the menu reads as "tidy this up" then "remove them" then "roles"
  const cleanup = [];
  const items = [];

  cleanup.push({
    icon: '<i class="fas fa-broom"></i>',
    label: "Wipe typed text",
    desc: "Clear what they have typed, for everyone",
    onClick: () => socket.emit("staff wipe buffer", { targetUserId: user.id }),
  });
  cleanup.push({
    icon: '<i class="fas fa-user-secret"></i>',
    label: "Reset name to Anonymous",
    desc: "Clear an offensive username",
    onClick: async () => {
      if (
        await StaffUI.confirm({
          title: "Reset name",
          message: `Reset ${name}'s username to Anonymous?`,
          confirmText: "Reset name",
        })
      )
        socket.emit("staff rename", { targetUserId: user.id });
    },
  });
  cleanup.push({
    icon: '<i class="fas fa-location-dot"></i>',
    label: "Reset location",
    desc: "Set their location back to On The Web",
    onClick: async () => {
      if (
        await StaffUI.confirm({
          title: "Reset location",
          message: `Reset ${name}'s location to "On The Web"?`,
          confirmText: "Reset location",
        })
      )
        socket.emit("staff reset location", { targetUserId: user.id });
    },
  });
  cleanup.push({
    icon: '<i class="fas fa-image-portrait"></i>',
    label: "Turn profile picture off",
    desc: "Remove it and stop them re-adding it",
    onClick: async () => {
      if (
        await StaffUI.confirm({
          title: "Turn profile picture off",
          message: `Remove ${name}'s profile picture? They cannot put it back until staff allow it again.`,
          confirmText: "Turn it off",
        })
      )
        socket.emit("staff set pfp blocked", {
          targetUserId: user.id,
          blocked: true,
        });
    },
  });
  cleanup.push({
    icon: '<i class="fas fa-rotate-left"></i>',
    label: "Allow profile picture again",
    desc: "Undo a picture block",
    onClick: () =>
      socket.emit("staff set pfp blocked", {
        targetUserId: user.id,
        blocked: false,
      }),
  });

  // Kick. Full mods/devs also place a room ban; junior mods can only remove.
  items.push({
    icon: '<i class="fas fa-user-slash"></i>',
    label: "Kick from room",
    danger: true,
    desc: "Remove from this room (no ban)",
    onClick: async () => {
      if (
        await StaffUI.confirm({
          title: "Kick",
          message: `Remove ${name} from this room?`,
          danger: true,
          confirmText: "Kick",
        })
      ) {
        socket.emit("staff kick", { targetUserId: user.id, ban: false });
      }
    },
  });

  if (isFullMod) {
    items.push({
      icon: '<i class="fas fa-user-slash"></i>',
      label: "Kick and room ban",
      danger: true,
      desc: "Remove and ban from this room",
      onClick: async () => {
        if (
          await StaffUI.confirm({
            title: "Kick + ban",
            message: `Kick and room-ban ${name}?`,
            danger: true,
            confirmText: "Kick + ban",
          })
        ) {
          socket.emit("staff kick", { targetUserId: user.id, ban: true });
        }
      },
    });
  }

  // IP block - full mods / devs only.
  if (isFullMod) {
    items.push({
      icon: '<i class="fas fa-ban"></i>',
      label: "IP block...",
      danger: true,
      desc: "Block this user's IP for a set time",
      onClick: () => openIpBlockPicker(user),
    });
  }

  // Warn: available to every mod level.
  items.push({
    icon: '<i class="fas fa-bullhorn"></i>',
    label: "Warn...",
    desc: "Send a private warning",
    onClick: async () => {
      const r = await StaffUI.prompt({
        title: `Warn ${name}`,
        icon: '<i class="fas fa-bullhorn"></i>',
        fields: [
          {
            name: "value",
            label: "Warning message",
            type: "textarea",
            placeholder: "Please follow the room rules...",
            maxLength: 1000,
            required: true,
          },
        ],
        confirmText: "Send warning",
      });
      if (r != null)
        socket.emit("staff warn", { targetUserId: user.id, message: r });
    },
  });

  // Grant a mod role to a normal user. Devs choose the level; full (L2) mods
  // may mint a junior (L1) key only. The server re-checks who may grant what.
  const makeModItem = {
    icon: '<i class="fas fa-user-shield"></i>',
    label: currentUserIsDev ? "Make this user a mod..." : "Make junior mod",
    desc: currentUserIsDev
      ? "Promote - choose a level"
      : "Grant a junior (level 1) mod key",
    onClick: async () => {
      if (currentUserIsDev) {
        StaffUI.menu({
          title: `Make ${name} a mod`,
          icon: '<i class="fas fa-user-shield"></i>',
          subtitle: "Choose a level",
          groups: [
            {
              items: [
                {
                  icon: '<i class="fas fa-user-shield"></i>',
                  label: "Junior mod (L1)",
                  desc: "Kick, warn, rename, wipe - no ban or IP block",
                  onClick: () =>
                    socket.emit("dev grant mod to user", {
                      targetUserId: user.id,
                      level: 1,
                    }),
                },
                {
                  icon: '<i class="fas fa-user-gear"></i>',
                  label: "Full mod (L2)",
                  desc: "All mod powers, including ban and IP block",
                  onClick: () =>
                    socket.emit("dev grant mod to user", {
                      targetUserId: user.id,
                      level: 2,
                    }),
                },
              ],
            },
          ],
        });
      } else if (
        await StaffUI.confirm({
          title: "Make junior mod",
          message: `Grant ${name} a junior (level 1) mod key? They can moderate immediately.`,
          confirmText: "Make junior mod",
        })
      )
        socket.emit("dev grant mod to user", {
          targetUserId: user.id,
          level: 1,
        });
    },
  };

  const roles = [];
  if (currentUserIsDev) {
    roles.push({
      icon: '<i class="fas fa-snowflake"></i>',
      label: "Freeze / unfreeze input",
      desc: "Lock their typing without kicking",
      onClick: () => socket.emit("staff freeze", { targetUserId: user.id }),
    });
    if (!user.isDev && !user.isMod) roles.push(makeModItem);
    if (user.isMod && !user.isDev) {
      const lvl = user.modLevel || 2;
      roles.push(
        lvl < 2
          ? {
            icon: '<i class="fas fa-arrow-up"></i>',
            label: "Promote to full mod (L2)",
            desc: "Grant full mod powers",
            onClick: async () => {
              if (
                await StaffUI.confirm({
                  title: "Promote to L2",
                  message: `Promote ${name} to a full (level 2) moderator?`,
                  confirmText: "Promote",
                })
              )
                socket.emit("dev set mod level for user", {
                  targetUserId: user.id,
                  level: 2,
                });
            },
          }
          : {
            icon: '<i class="fas fa-arrow-down"></i>',
            label: "Demote to junior (L1)",
            desc: "Limit them to junior powers",
            onClick: async () => {
              if (
                await StaffUI.confirm({
                  title: "Demote to L1",
                  message: `Demote ${name} to a junior (level 1) moderator?`,
                  confirmText: "Demote",
                })
              )
                socket.emit("dev set mod level for user", {
                  targetUserId: user.id,
                  level: 1,
                });
            },
          },
      );
      roles.push({
        icon: '<i class="fas fa-user-xmark"></i>',
        label: "Remove mod (revoke key)",
        desc: "Revoke this user's mod key now",
        danger: true,
        onClick: async () => {
          // The reason goes on their former-staff record in the dashboard, so
          // it is asked for here too rather than only in the Moderators tab.
          const r = await StaffUI.prompt({
            title: "Remove mod",
            icon: '<i class="fas fa-user-xmark"></i>',
            message: `Demote ${name} back to a normal user? Their mod key is revoked immediately.`,
            fields: [
              {
                name: "reason",
                label: "Why are they no longer a moderator?",
                type: "textarea",
                placeholder: "e.g. Stepped down, inactive, abused the role",
                required: true,
                maxLength: 300,
              },
            ],
            danger: true,
            confirmText: "Remove mod",
          });
          if (r && r.reason && r.reason.trim())
            socket.emit("dev revoke mod from user", {
              targetUserId: user.id,
              reason: r.reason.trim(),
            });
        },
      });
    }
  } else if (currentUserIsMod && currentUserModLevel >= 2) {
    if (!user.isDev && !user.isMod) roles.push(makeModItem);
  }

  const groups = [
    { title: "Clean up what they show", items: cleanup },
    { title: "Warn and remove", items },
  ];
  if (roles.length) groups.push({ title: "Role", items: roles });

  StaffUI.menu({
    title: `Actions: ${name}`,
    icon: '<i class="fas fa-shield-halved"></i>',
    subtitle: "Per-user moderation",
    groups,
    onHelp: () => StaffUI.help(staffRole()),
  });
}

function openIpBlockPicker(user) {
  const durs = [
    { icon: '<i class="fas fa-clock"></i>', label: "1 hour", value: "1h" },
    { icon: '<i class="fas fa-clock"></i>', label: "24 hours", value: "24h" },
    {
      icon: '<i class="fas fa-calendar-days"></i>',
      label: "7 days",
      value: "7d",
    },
  ];
  if (currentUserIsDev)
    durs.push({
      icon: '<i class="fas fa-infinity"></i>',
      label: "Permanent",
      value: "permanent",
    });
  StaffUI.menu({
    title: `IP block: ${user.username || "user"}`,
    icon: '<i class="fas fa-ban"></i>',
    subtitle: "Pick a duration",
    groups: [
      {
        items: durs.map((d) => ({
          icon: d.icon,
          label: d.label,
          danger: true,
          onClick: async () => {
            const res = await StaffUI.prompt({
              title: "Block IP",
              icon: '<i class="fas fa-ban"></i>',
              message: `Block this user's IP for ${d.label}? They'll be disconnected immediately.`,
              fields: [
                {
                  name: "reason",
                  label: "Message to show the blocked user (optional)",
                  type: "textarea",
                  placeholder: "e.g. Repeated harassment after warnings.",
                  maxLength: 500,
                },
                {
                  name: "banRange",
                  type: "checkbox",
                  label: "Also block their surrounding range",
                  // Off by default. This used to be on, which was harmless
                  // because a range only ever applied to IPv6. Now that IPv4
                  // resolves to a /24 it can cover 256 addresses, so it has to
                  // be a deliberate choice rather than a default.
                  value: false,
                  help: "Covers the whole network they sit on (IPv6 /64, or IPv4 /24, which is up to 256 addresses) instead of the single address. Use it for someone who keeps returning on a neighbouring address, not as a matter of course.",
                },
              ],
              danger: true,
              confirmText: "Block IP",
            });
            if (res != null)
              socket.emit("staff ip block", {
                targetUserId: user.id,
                duration: d.value,
                reason: res.reason || "",
                banRange: !!res.banRange,
              });
          },
        })),
      },
    ],
  });
}

// ── Room / dev tools panel ───────────────────────────────────────────────────
function createStaffPanelButton() {
  const navRight = document.querySelector(".navbar-right");
  if (!navRight || document.getElementById("staffPanelButton")) return;
  const button = document.createElement("button");
  button.id = "staffPanelButton";
  button.type = "button";
  button.className = "staff-nav-btn";
  button.innerHTML = currentUserIsDev
    ? '<i class="fas fa-screwdriver-wrench"></i> Dev'
    : '<i class="fas fa-shield-halved"></i> Staff';
  button.title = "Staff tools";
  button.addEventListener("click", openStaffPanel);
  const leaveBtn = navRight.querySelector(".leave-room");
  if (leaveBtn) navRight.insertBefore(button, leaveBtn);
  else navRight.appendChild(button);
}

function openStaffPanel() {
  if (!window.StaffUI) return;
  const rid = currentRoomId;
  // Every staff level can tidy a room: clear the board, rename it, lock it, or
  // slow it down, all reversible. Closing a room deletes it, so that stays with
  // full (level 2) mods. The server enforces this regardless of what shows here.
  const isFullMod =
    currentUserIsDev || (currentUserIsMod && currentUserModLevel >= 2);
  const roomItems = [
    {
      icon: '<i class="fas fa-comments"></i>',
      label: "Open the Desk",
      desc: "Staff chat: pings, presence, and the room map",
      onClick: () => window.TalkoDesk && window.TalkoDesk.open(),
    },
    {
      icon: '<i class="fas fa-eraser"></i>',
      label: "Clear Talkoboard",
      desc: "Wipe the shared drawing board",
      onClick: () => socket.emit("board clear"),
    },
    {
      icon: '<i class="fas fa-pen"></i>',
      label: "Rename room...",
      desc: "Fix a bad or misleading room name",
      onClick: async () => {
        const name = await StaffUI.prompt({
          title: "Rename room",
          icon: '<i class="fas fa-pen"></i>',
          subtitle: currentRoomName || "this room",
          message:
            "Everyone in the room is told about the change, and it is written to the audit log.",
          fields: [
            {
              name: "value",
              label: "New room name",
              type: "text",
              value: currentRoomName || "",
              maxLength: 30,
              required: true,
            },
          ],
          confirmText: "Rename",
        });
        if (name != null)
          socket.emit("staff rename room", { roomId: rid, name });
      },
    },
    {
      icon: currentRoomLocked
        ? '<i class="fas fa-lock-open"></i>'
        : '<i class="fas fa-lock"></i>',
      label: currentRoomLocked ? "Unlock room" : "Lock room",
      desc: "Block new joins; current users stay",
      onClick: () =>
        socket.emit("staff lock room", {
          roomId: rid,
          locked: !currentRoomLocked,
        }),
    },
    {
      icon: '<i class="fas fa-gauge"></i>',
      label: currentRoomSlow ? "Slow mode: turn OFF" : "Slow mode: turn ON",
      desc: "Throttle the room's update speed",
      onClick: () =>
        socket.emit("staff slow mode", {
          roomId: rid,
          enabled: !currentRoomSlow,
        }),
    },
  ];
  if (isFullMod) {
    roomItems.push({
      icon: '<i class="fas fa-trash"></i>',
      label: "Close room",
      danger: true,
      desc: "Kick everyone and delete the room",
      onClick: async () => {
        if (
          await StaffUI.confirm({
            title: "Close room",
            message: "Kick everyone and delete this room?",
            danger: true,
            confirmText: "Close room",
          })
        )
          socket.emit("staff close room", { roomId: rid });
      },
    });
  }
  const groups = [];
  if (roomItems.length) groups.push({ title: "This room", items: roomItems });

  // Appearance (moved out of the navbar to keep it tidy on mobile)
  const appearanceItems = [
    {
      id: "staffHideItem",
      icon: currentUserIsHidden
        ? '<i class="fas fa-eye-slash"></i>'
        : '<i class="fas fa-eye"></i>',
      label: currentUserIsHidden ? "Show my flair" : "Hide my flair",
      desc: currentUserIsDev
        ? "Hide/show your crown, color and glow"
        : "Hide/show your MOD badge",
      onClick: () =>
        socket.emit("dev set hide", { isHidden: !currentUserIsHidden }),
    },
  ];
  if (currentUserIsDev) {
    appearanceItems.push({
      id: "staffVanishItem",
      icon: '<i class="fas fa-ghost"></i>',
      label: currentUserIsVanished ? "Vanish: ON" : "Vanish: OFF",
      desc: "Invisible to non-devs; takes no room slot",
      onClick: () =>
        socket.emit("dev set vanish", { isVanished: !currentUserIsVanished }),
    });
    appearanceItems.push({
      icon: '<i class="fas fa-palette"></i>',
      label: "Custom name color...",
      desc: "Set your chat text color",
      onClick: async () => {
        const color = await StaffUI.prompt({
          title: "Custom name color",
          icon: '<i class="fas fa-palette"></i>',
          fields: [
            {
              name: "value",
              label: "Pick a color",
              type: "color",
              value: localStorage.getItem("talkomatic_devColor") || "#ff9800",
            },
          ],
          confirmText: "Apply",
        });
        if (color) {
          localStorage.setItem("talkomatic_devColor", color);
          socket.emit("dev set color", { color });
          applyDevColor(color);
        }
      },
    });
    appearanceItems.push({
      id: "staffIpItem",
      icon: devShowIP
        ? '<i class="fas fa-globe"></i>'
        : '<i class="fas fa-eye-slash"></i>',
      label: devShowIP ? "User IPs: showing" : "User IPs: hidden",
      desc: "Show or hide the IP tag on each user",
      onClick: () => {
        devShowIP = !devShowIP;
        localStorage.setItem(
          "talkomatic_devShowIP",
          devShowIP ? "true" : "false",
        );
        setStaffItemLabel(
          "staffIpItem",
          devShowIP ? "User IPs: showing" : "User IPs: hidden",
        );
        renderDevContext();
      },
    });
  }
  groups.push({ title: "How you appear", items: appearanceItems });

  if (currentUserIsDev) {
    groups.push({
      title: "Announce to this room",
      items: [
        {
          icon: '<i class="fas fa-tower-broadcast"></i>',
          label: "Megaphone this room...",
          desc: "Announcement banner to this room",
          onClick: async () => {
            const m = await StaffUI.prompt({
              title: "Megaphone (this room)",
              icon: '<i class="fas fa-tower-broadcast"></i>',
              fields: [
                {
                  name: "value",
                  label: "Announcement",
                  type: "textarea",
                  maxLength: 300,
                  required: true,
                },
              ],
              confirmText: "Broadcast",
            });
            if (m)
              socket.emit("staff megaphone", {
                scope: "room",
                roomId: rid,
                message: m,
              });
          },
        },
        {
          icon: '<i class="fas fa-champagne-glasses"></i>',
          label: "Party mode",
          desc: "Confetti + party horn for everyone",
          onClick: () => socket.emit("staff party", { roomId: rid }),
        },
        {
          icon: '<i class="fas fa-star"></i>',
          label: currentRoomSpotlight ? "Remove spotlight" : "Spotlight room",
          desc: "Pin to top of lobby with an Official badge",
          onClick: () =>
            socket.emit("staff spotlight", {
              roomId: rid,
              on: !currentRoomSpotlight,
            }),
        },
        {
          icon: '<i class="fas fa-chart-simple"></i>',
          label: "Server HUD (toggle)",
          desc: "Live server stats overlay",
          onClick: toggleDevHud,
        },
      ],
    });
    groups.push({
      title: "Whole server",
      items: [
        {
          icon: '<i class="fas fa-flag"></i>',
          label: "Feature flags...",
          desc: "Word filter / room creation / limit",
          onClick: () => socket.emit("dev get flags"),
        },
        {
          icon: '<i class="fas fa-screwdriver-wrench"></i>',
          label: "Maintenance mode (toggle)",
          desc: "Pause new rooms + joins",
          onClick: () => socket.emit("dev set maintenance", {}),
        },
        {
          icon: '<i class="fas fa-bomb"></i>',
          label: "NUKE all rooms",
          danger: true,
          desc: "Emergency clear of every room",
          onClick: async () => {
            const r = await StaffUI.prompt({
              title: "Nuke all rooms",
              icon: '<i class="fas fa-bomb"></i>',
              danger: true,
              message:
                "This clears EVERY room and removes ALL users. Type NUKE to confirm.",
              fields: [
                {
                  name: "value",
                  label: "Type NUKE",
                  placeholder: "NUKE",
                  required: true,
                },
              ],
              confirmText: "NUKE",
            });
            if (r && r.trim().toUpperCase() === "NUKE")
              socket.emit("staff nuke", { confirm: true });
            else if (r != null)
              notify(
                "Nuke cancelled. The confirmation text did not match.",
                "info",
              );
          },
        },
      ],
    });
  }

  groups.push({
    title: "Records",
    items: [
      {
        icon: '<i class="fas fa-clipboard"></i>',
        label: "Open Mod Dashboard",
        desc: "Every staff action + identity change",
        onClick: () => window.open("/mod.html", "_blank"),
      },
    ],
  });

  // Name the rank in the subtitle so a junior can see at a glance why some
  // actions are not offered to them.
  const rankLabel = currentUserIsDev
    ? "Developer"
    : currentUserModLevel >= 2
      ? "Full mod (L2)"
      : "Junior mod (L1)";

  StaffUI.panel({
    title: "Staff panel",
    icon: currentUserIsDev
      ? '<i class="fas fa-screwdriver-wrench"></i>'
      : '<i class="fas fa-shield-halved"></i>',
    subtitle: rankLabel,
    groups,
    onHelp: () => StaffUI.help(staffRole()),
    // Reflow the user-box grid when the drawer pushes the room aside, so a busy
    // room stays fully visible beside the panel instead of hidden behind it.
    onLayoutChange: adjustLayout,
  });
}

socket.on("dev flags", (flags) => {
  if (!flags || !window.StaffUI) return;
  StaffUI.menu({
    title: "Feature flags",
    icon: '<i class="fas fa-flag"></i>',
    subtitle: "Live server configuration",
    groups: [
      {
        items: [
          {
            icon: flags.wordFilter
              ? '<i class="fas fa-circle-check"></i>'
              : '<i class="fas fa-ban"></i>',
            label: `Word filter (global): ${flags.wordFilter ? "ON" : "OFF"}`,
            desc: "Toggle the global word filter",
            onClick: () =>
              socket.emit("dev set flags", { wordFilter: !flags.wordFilter }),
          },
          {
            icon: flags.roomCreation
              ? '<i class="fas fa-circle-check"></i>'
              : '<i class="fas fa-ban"></i>',
            label: `Room creation: ${flags.roomCreation ? "ON" : "OFF"}`,
            desc: "Allow users to create rooms",
            onClick: () =>
              socket.emit("dev set flags", {
                roomCreation: !flags.roomCreation,
              }),
          },
          {
            icon: '<i class="fas fa-hashtag"></i>',
            label: `Room limit: ${flags.baseMaxRooms}`,
            desc: "How many rooms can exist at once",
            onClick: async () => {
              const v = await StaffUI.prompt({
                title: "Room limit",
                fields: [
                  {
                    name: "value",
                    label: "Base room limit",
                    type: "number",
                    value: String(flags.baseMaxRooms),
                    required: true,
                  },
                ],
              });
              const n = parseInt(v, 10);
              if (Number.isFinite(n))
                socket.emit("dev set flags", { baseMaxRooms: n });
            },
          },
          {
            icon: '<i class="fas fa-users"></i>',
            label: `Max size (this room): ${currentRoomMaxSize || flags.maxRoomCapacity} people`,
            desc: "Capacity for THIS room only (2 to 50)",
            onClick: async () => {
              const v = await StaffUI.prompt({
                title: "Max size for this room",
                icon: '<i class="fas fa-users"></i>',
                message:
                  "How many people can be in THIS room (2 to 50)? Other rooms keep the default limit.",
                fields: [
                  {
                    name: "value",
                    label: "Max users in this room",
                    type: "number",
                    value: String(currentRoomMaxSize || flags.maxRoomCapacity),
                    required: true,
                  },
                ],
              });
              const n = parseInt(v, 10);
              if (Number.isFinite(n))
                socket.emit("dev set room size", { size: n });
            },
          },
          {
            icon: flags.maintenance
              ? '<i class="fas fa-screwdriver-wrench"></i>'
              : '<i class="fas fa-circle-check"></i>',
            label: `Maintenance: ${flags.maintenance ? "ON" : "OFF"}`,
            desc: "Toggle maintenance mode",
            onClick: () => socket.emit("dev set maintenance", {}),
          },
        ],
      },
    ],
  });
});

// ── Dev HUD overlay ──────────────────────────────────────────────────────────
function toggleDevHud() {
  let hud = document.getElementById("devHud");
  if (hud) {
    hud.remove();
    if (hudInterval) clearInterval(hudInterval);
    hudInterval = null;
    return;
  }
  hud = document.createElement("div");
  hud.id = "devHud";
  hud.textContent = "HUD: loading...";
  document.body.appendChild(hud);
  const poll = () => socket.emit("dev request hud");
  poll();
  hudInterval = setInterval(poll, 3000);
}

socket.on("dev hud stats", (s) => {
  const hud = document.getElementById("devHud");
  if (!hud || !s) return;
  hud.textContent =
    "SERVER HUD\n" +
    `sockets  ${s.sockets}\n` +
    `rooms    ${s.rooms}\n` +
    `users    ${s.users}\n` +
    `heap     ${s.heapMB} MB\n` +
    `soloTTL  ${s.soloTTL}s\n` +
    `boards   ${s.boards}\n` +
    `tokens   ${s.tokens}\n` +
    `devs     ${s.devs}`;
});

// ── Room flag chips (LOCKED / SLOW / OFFICIAL) ───────────────────────────────
function applyRoomFlags(data) {
  if (!data) return;
  if (typeof data.locked === "boolean") currentRoomLocked = data.locked;
  if (typeof data.slowMode === "boolean") currentRoomSlow = data.slowMode;
  if (typeof data.spotlight === "boolean")
    currentRoomSpotlight = data.spotlight;
  const navbar = document.querySelector(".second-navbar");
  if (!navbar) return;
  let flags = document.getElementById("roomStaffFlags");
  if (!flags) {
    flags = document.createElement("div");
    flags.id = "roomStaffFlags";
    navbar.appendChild(flags);
  }
  flags.textContent = "";
  const add = (text, cls) => {
    const s = document.createElement("span");
    s.textContent = text;
    s.className = "room-flag " + cls;
    flags.appendChild(s);
  };
  if (currentRoomSpotlight) add("★ OFFICIAL", "f-official");
  if (currentRoomLocked) add("LOCKED", "f-locked");
  if (currentRoomSlow) add("SLOW", "f-slow");
}

// ── Spectate (read-only) ─────────────────────────────────────────────────────
function renderSpectate(data) {
  isSpectating = true;
  currentRoomId = data.roomId;
  currentRoomName = data.roomName;
  currentRoomLayout = data.layout || currentRoomLayout;
  currentRoomCreatedAt = data.createdAt || 0;

  // Carry the spectator's role through so the full staff panel is available
  // while watching: devs keep every dev power (including Max room size), mods
  // get the mod panel. Drawing/typing stays blocked server-side via spectating.
  currentUserIsDev = !!data.isDev;
  currentUserIsMod = !!data.isMod;
  currentUserModLevel = data.modLevel || 0;

  const rt = document.querySelector(".second-navbar .room-type");
  const rn = document.querySelector(".second-navbar .room-name");
  const ru = document.querySelector(".second-navbar .room-uptime");
  const rid = document.querySelector(".second-navbar .room-id");
  if (rt) rt.textContent = `${getRoomTypeDisplay(data.roomType) || "Public"} room`;
  if (rn) rn.textContent = data.roomName || "*";
  if (ru) ru.textContent = currentRoomCreatedAt > 0 ? msToTime(Date.now() - currentRoomCreatedAt) : "";
  if (rid) rid.textContent = data.roomId ? "Room ID: " + data.roomId : "*";
  const c = document.querySelector(".chat-container");
  if (c) {
    // Same atomic swap as updateRoomUI so spectating an active room doesn't
    // flash a half-built user list on slower devices.
    const frag = document.createDocumentFragment();
    (data.users || []).forEach((u) => createUserRow(u, frag));
    c.innerHTML = "";
    c.appendChild(frag);
    adjustVoteButtonVisibility();
  }
  adjustLayout();
  if (data.currentMessages) updateCurrentMessages(data.currentMessages);

  // Build the staff/dev tools button and reflect this room's live flags.
  if (isStaff()) createStaffPanelButton();
  applyRoomFlags(data);

  if (data.queue !== undefined) renderQueueChip(data.queue);

  const invite = document.querySelector(".invite-section");
  if (invite) invite.style.display = "none";
  let banner = document.getElementById("spectateBanner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "spectateBanner";
    document.body.appendChild(banner);
  }
  // "room queued" carries a position; plain spectating (staff, ?spectate=1)
  // does not. Same read-only rendering either way, different framing.
  if (data.position) {
    banner.textContent =
      `WAITING (#${data.position} in line, read-only). You'll join ` +
      `automatically when a seat opens - the room is watching you watch it.`;
  } else {
    banner.textContent = currentUserIsDev
      ? "SPECTATING (invisible, read-only). Dev tools stay active via the Dev button."
      : currentUserIsMod
        ? "SPECTATING (invisible, read-only). Mod tools stay active via the Staff button."
        : "SPECTATING (read-only). You are watching this room. Use Leave to exit.";
  }
}

socket.on("spectate joined", (data) => renderSpectate(data));
socket.on("room queued", (data) => renderSpectate(data));
socket.on("spectate ended", () => {
  isSpectating = false;
  window.location.href = "/index.html";
});

// The server already sent (or is about to send) a normal "room joined" for
// this - this is just the heads-up so the transition doesn't feel silent.
socket.on("queue promoted", (data) => {
  notify(`A seat opened up in ${data?.roomName ?? "the room"} - you're in!`, "success", {
    title: "Promoted from the queue",
    timeout: 6000,
  });
});

socket.on("room capacity evicted", (data) => {
  notify(
    `The room filled up and you'd been quiet a while, so you gave up your seat ` +
      `in ${data?.roomName ?? "the room"}. You're back in the queue - it'll ` +
      `open up again automatically.`,
    "warning",
    { title: "Seat yielded", timeout: 10000 },
  );
});

// ── Staff events received by everyone ────────────────────────────────────────
socket.on("staff warning", (data) =>
  notify((data && data.message) || "Please follow the room rules.", "warning", {
    title: "Staff warning",
    timeout: 12000,
  }),
);
socket.on("staff frozen", (data) => {
  const frozen = !!(data && data.frozen);
  if (chatInput) {
    chatInput.contentEditable = !frozen && !isSpectating;
    chatInput.style.opacity = frozen ? "0.5" : "1";
  }
  notify(
    frozen
      ? "Your input has been frozen by staff."
      : "Your input has been unfrozen.",
    frozen ? "warning" : "success",
  );
});
socket.on("buffer wiped", () => {
  selfRawText = "";
  lastSentMessage = "";
  // Clear the live input node straight from the DOM (not just the cached
  // reference, which can go stale after a re-render) so the text really
  // disappears from the wiped user's own textbox.
  const ci =
    document.querySelector(
      `.chat-row[data-user-id="${currentUserId}"] .chat-input`,
    ) || chatInput;
  if (ci) {
    ci.innerHTML = "";
    ci.textContent = "";
  }
  notify("Your message was cleared by staff.", "info");
});
socket.on("user renamed", (data) => {
  if (!data || !data.userId) return;
  const row = document.querySelector(
    `.chat-row[data-user-id="${data.userId}"]`,
  );
  if (!row) return;
  const info = row.querySelector(".user-info");
  if (!info) return;
  const nameEl = info.querySelector(".ui-name");
  if (nameEl) {
    nameEl.textContent = data.username;
    return;
  }
  for (const node of Array.from(info.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      node.textContent = data.username;
      return;
    }
  }
  info.appendChild(document.createTextNode(data.username));
});
socket.on("room lock status", (data) => {
  currentRoomLocked = !!(data && data.locked);
  applyRoomFlags({ locked: currentRoomLocked });
  notify(
    currentRoomLocked
      ? "This room is now locked. No new joins."
      : "This room is unlocked.",
    "info",
  );
});
socket.on("room renamed", (data) => {
  if (!data || !data.name) return;
  currentRoomName = data.name;
  const rn = document.querySelector(".second-navbar .room-name");
  if (rn) rn.textContent = data.name;
  const nameEl = document.querySelector(".room-name");
  if (nameEl && nameEl !== rn) nameEl.textContent = `Room: ${data.name}`;
  notify(`This room was renamed to "${data.name}" by staff.`, "info");
});
socket.on("room slow mode", (data) => {
  currentRoomSlow = !!(data && data.enabled);
  applyRoomFlags({ slowMode: currentRoomSlow });
  notify(
    currentRoomSlow ? "Slow mode enabled." : "Slow mode disabled.",
    "info",
  );
});
socket.on("megaphone", (data) => {
  if (!data || !data.message) return;
  notify(data.message, "warning", {
    title: "Announcement",
    fullWidth: true,
    timeout: 14000,
  });
});
socket.on("party mode", () => {
  try {
    triggerDevConfetti();
  } catch (_) { }
  try {
    if (!partyHornAudio) partyHornAudio = new Audio("audio/party-horn.mp3");
    partyHornAudio.currentTime = 0;
    partyHornAudio.play().catch(() => { });
  } catch (_) { }
});
socket.on("maintenance status", (data) => {
  if (data && data.enabled)
    notify(
      "Talkomatic is in maintenance mode. New rooms and joins are paused.",
      "warning",
      {
        title: "Maintenance",
        timeout: 8000,
      },
    );
});
socket.on("staff action result", (data) => {
  if (!data) return;
  if (data.action === "room size" && data.size) currentRoomMaxSize = data.size;
  // Shared wording, so the same action reads identically here and in the
  // dashboard, and says who it hit and what it actually did.
  if (window.StaffUI) StaffUI.actionToast(data);
  else notify((data.ok ? "Done: " : "Failed: ") + data.action, data.ok ? "success" : "error");
});
socket.on("staff revoked", () => {
  localStorage.removeItem("talkomatic_modKey");
  currentUserIsMod = false;
  currentUserModLevel = 0;
  notify("Your mod key was revoked.", "warning", { timeout: 6000 });
  setTimeout(() => window.location.reload(), 1500);
});

// ── Staff key entry (no console needed) ──────────────────────────────────────
let pendingStaffKey = null;
async function openStaffKeyEntry() {
  if (!window.StaffUI) return;
  const key = await StaffUI.prompt({
    title: "Staff access",
    icon: '<i class="fas fa-key"></i>',
    subtitle: "Enter your dev or mod key",
    message:
      "Your key is verified on the server and saved to this browser. It never appears in the URL.",
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
    notify(
      d && d.throttled
        ? "Too many attempts. Wait a few minutes."
        : "That key was not recognized.",
      "error",
    );
    pendingStaffKey = null;
    return;
  }
  if (d.role === "dev")
    localStorage.setItem("talkomatic_devKey", pendingStaffKey);
  else localStorage.setItem("talkomatic_modKey", pendingStaffKey);
  pendingStaffKey = null;
  notify(
    `Key accepted. You are ${d.role}${d.label ? " (" + d.label + ")" : ""}. Reloading...`,
    "success",
  );
  setTimeout(() => window.location.reload(), 1200);
});
socket.on("you are now mod", (d) => {
  if (!d || !d.key) return;
  localStorage.setItem("talkomatic_modKey", d.key);
  notify(
    d.level === 2
      ? "You've been promoted to Moderator (full)! Reloading..."
      : "You've been made a Junior Moderator! Reloading...",
    "success",
    { title: "You are now a mod", timeout: 4000 },
  );
  setTimeout(() => window.location.reload(), 1600);
});
// Live level change (promote/demote) without a reload: update our cached level
// so the next staff menu reflects the new powers. Our own badge refreshes via
// the room user-update broadcast.
socket.on("staff level changed", (d) => {
  if (!d) return;
  currentUserModLevel = d.level === 1 ? 1 : 2;
  notify(
    currentUserModLevel >= 2
      ? "You are now a full (level 2) moderator."
      : "Your moderator level is now junior (level 1).",
    "info",
    { timeout: 6000 },
  );
});
// Device identity: stash the activity summary for later features.
socket.on("identity status", (d) => {
  if (window.TalkomaticIdentity) window.TalkomaticIdentity.activity = d || null;
});
socket.on("report received", () =>
  notify("Thanks - your report was sent to the moderators.", "success"),
);
// Staff-only live alerts (reports, mod-abuse flags). The server only emits this
// to qualifying staff sockets, so non-staff never receive it.
socket.on("staff notice", (d) => {
  if (d && d.text)
    notify(d.text, "warning", { title: "Staff alert", timeout: 8000 });
});

// Invite referral capture: ?ref=CODE records (once, server-side) who referred
// this browser, in case someone lands straight in a room from an invite link.
(function captureInviteRef() {
  try {
    const code = new URLSearchParams(window.location.search).get("ref");
    if (!code) return;
    const send = () => socket.emit("invite ref", { code });
    socket.on("connect", send);
    if (socket.connected) send();
    const url = new URL(window.location.href);
    url.searchParams.delete("ref");
    window.history.replaceState({}, document.title, url);
  } catch (e) { }
})();

// Open the key-entry modal when the page is opened with #staff in the URL
if (window.location.hash === "#staff") setTimeout(openStaffKeyEntry, 600);
window.addEventListener("hashchange", () => {
  if (window.location.hash === "#staff") openStaffKeyEntry();
});

// Room-specific staff styles (badges, nav button, HUD, flags, spectate banner)
(function injectRoomStaffStyles() {
  const css = `
    .user-info{flex-wrap:nowrap;overflow:hidden;}
    .ui-name{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .dev-meta{flex:0 0 auto;max-width:42%;overflow:hidden;text-overflow:ellipsis;}
    .mod-badge{display:inline-block;background:#5aa9ff;color:#001229;font-size:9px;font-weight:bold;padding:1px 5px;border-radius:8px;margin:0 5px 0 0;letter-spacing:.5px;vertical-align:middle;flex:0 0 auto;}
    .mod-badge.mod-badge-jr{background:#c08bff;color:#16002b;}
    .device-icon{color:#7f8794;font-size:11px;margin-right:6px;flex:0 0 auto;}
    .invite-trophy{height:15px;width:auto;margin-right:5px;flex:0 0 auto;vertical-align:middle;}
    .staff-action-button{background:none;border:none;cursor:pointer;font-size:13px;margin-left:4px;opacity:.75;}
    .staff-action-button:hover{opacity:1;}
    .staff-nav-btn{display:flex;align-items:center;gap:6px;margin-right:8px;padding:10px 12px;border:1px solid #ff9800;border-radius:4px;background:#000;color:#ff9800;cursor:pointer;font-size:12px;font-weight:bold;font-family:inherit;transition:all .2s ease;}
    .staff-nav-btn:hover{background:#ff9800;color:#000;}
    #roomStaffFlags{display:flex;gap:6px;align-items:center;margin-left:8px;}
    .room-flag{font-size:10px;font-weight:bold;padding:2px 6px;border-radius:10px;}
    .room-flag.f-official{background:#ffd700;color:#3a2c00;}
    .room-flag.f-locked{background:#e5484d;color:#fff;}
    .room-flag.f-slow{background:#ff9800;color:#3a2c00;}
    #devHud{position:fixed;bottom:12px;left:12px;z-index:100000;background:rgba(10,11,14,.92);border:1px solid #ff9800;border-radius:10px;color:#ffb14d;font-family:monospace;font-size:12px;padding:12px 14px;line-height:1.6;pointer-events:none;white-space:pre;box-shadow:0 8px 30px rgba(0,0,0,.5);}
    #spectateBanner{position:fixed;top:0;left:0;right:0;z-index:99998;background:#5c2d91;color:#fff;text-align:center;font-size:13px;font-weight:bold;padding:6px 10px;letter-spacing:.5px;box-sizing:border-box;}
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
})();
