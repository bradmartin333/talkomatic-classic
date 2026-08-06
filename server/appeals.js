// server/appeals.js
// Ban-appeal store. A blocked user can appeal directly from the ban screen.
// Because their socket connection is refused at the door, the appeal comes in
// over plain HTTP (the IP block only rejects sockets), so this store is driven
// from the HTTP route in server.js, not the socket layer.
//
// Each appeal is keyed by the banned IP and remembers a snapshot of the ban it
// is contesting (who placed it, the reason, when it ends) so staff have the
// full picture in the Appeals tab without a second lookup. One open appeal per
// IP, so a banned user cannot spam the inbox.
//
// An appeal is a CONVERSATION, not a single note: staff can ask what actually
// happened and the user can answer, which is the only way most bans can be
// judged fairly. Staff can end the chat (a spammer loses the reply box but
// keeps the appeal) and then decide. Everything is capped and throttled,
// because the one person guaranteed to be annoyed here is the one typing.
//
// Persisted to appeals.json the same way as the other JSON stores (atomic
// tmp + rename, debounced), capped, pruned, and never committed.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "appeals.json");
const MAX = 2000;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // keep appeals for 30 days

// Conversation limits. The user's side is throttled; staff are not, because a
// moderator typing too fast has never been the problem.
const MSG_MAX = 1000;
const THREAD_CAP = 120; // messages kept per appeal
const USER_MSG_CAP = 40; // how many the appellant may send in total
const USER_COOLDOWN_MS = 5000;

let appeals = []; // oldest first
let seq = 0;
let saveTimer = null;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    appeals = Array.isArray(arr) ? arr : [];
    seq = appeals.reduce((m, a) => Math.max(m, a.id || 0), 0);
    // Appeals filed before this was a conversation have one note and no
    // thread. Give them one so every appeal reads the same way.
    for (const a of appeals) {
      if (Array.isArray(a.messages)) continue;
      a.messages = a.message
        ? [{ id: 1, ts: a.at || Date.now(), from: "user", text: a.message }]
        : [];
      a.msgSeq = a.messages.length;
    }
    prune(Date.now());
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading appeals.json:", err);
    appeals = [];
  }
}

// Atomic write (tmp + rename), debounced, mirrors the other JSON stores.
function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      if (appeals.length > MAX) appeals = appeals.slice(-MAX);
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(appeals, null, 2), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("appeals save failed:", e);
    }
  }, 3000);
}

// Synchronous write for a clean shutdown (survives the debounce window).
function flushSync() {
  try {
    if (appeals.length > MAX) appeals = appeals.slice(-MAX);
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(appeals, null, 2), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("appeals flush failed:", e);
  }
}

function prune(now) {
  appeals = appeals.filter((a) => now - (a.at || 0) <= WINDOW_MS);
  if (appeals.length > MAX) appeals = appeals.slice(-MAX);
}

// The open (unreviewed) appeal for an IP, if any.
function openForIp(ip) {
  return appeals.find((a) => a.ip === ip && a.status === "open") || null;
}

// File a new appeal. Returns { ok, id } or { ok:false, code } so the HTTP
// route can give the banned user a clear message. One open appeal per IP.
function submit({ ip, deviceId, userId, name, message, ban }) {
  if (!ip) return { ok: false, code: "no_ip" };
  if (openForIp(ip)) return { ok: false, code: "already" };
  const now = Date.now();
  const a = {
    id: ++seq,
    ip,
    deviceId: deviceId || null,
    userId: userId || null,
    name: name || null,
    // Kept as the opening line for anything that only wants a summary.
    message: message || "",
    at: now,
    status: "open", // open | resolved
    resolution: null, // lifted | dismissed
    reviewedBy: null,
    reviewedAt: null,
    // The conversation. The first thing they wrote is the first message.
    msgSeq: 1,
    messages: [{ id: 1, ts: now, from: "user", text: message || "" }],
    // Staff can end the chat without deciding the appeal - a spammer stops
    // typing, the appeal still gets read.
    locked: false,
    lockedBy: null,
    lockedAt: null,
    // Snapshot of the ban being contested, so staff see the whole story.
    ban: ban || null,
  };
  appeals.push(a);
  if (appeals.length > MAX) appeals = appeals.slice(-MAX);
  prune(Date.now());
  saveSoon();
  return { ok: true, id: a.id };
}

function get(id) {
  return appeals.find((a) => a.id === id) || null;
}

// ── The conversation ────────────────────────────────────────────────────────

// The appeal this browser is looking at: their open one if they have it,
// otherwise the most recent, so a decision is still readable afterwards.
// Matched on address OR device id, because a range ban and an id ban both
// leave the exact address off the key.
function forUser(ip, deviceId) {
  const mine = appeals.filter(
    (a) => (ip && a.ip === ip) || (deviceId && a.deviceId === deviceId),
  );
  if (!mine.length) return null;
  return (
    mine.filter((a) => a.status === "open").sort((x, y) => y.at - x.at)[0] ||
    mine.sort((x, y) => y.at - x.at)[0]
  );
}

function pushMessage(a, msg) {
  a.msgSeq = (a.msgSeq || a.messages.length || 0) + 1;
  const m = { id: a.msgSeq, ts: Date.now(), ...msg };
  a.messages.push(m);
  // Oldest go first, but never the opening appeal: it is the thing being
  // judged, and a thread long enough to trim is exactly one where somebody
  // will want to re-read how it started.
  if (a.messages.length > THREAD_CAP)
    a.messages = [a.messages[0]].concat(
      a.messages.slice(a.messages.length - (THREAD_CAP - 1)),
    );
  saveSoon();
  return m;
}

// A quote of what is being answered, stored with the reply so it still reads
// after the original is trimmed.
function replySnapshot(a, replyToId) {
  const src = (a.messages || []).find((m) => m.id === Number(replyToId));
  if (!src) return null;
  return {
    id: src.id,
    from: src.from,
    by: src.by || null,
    text: String(src.text || "").slice(0, 120),
  };
}

// The appellant writes. Everything they can get wrong has its own code so the
// ban screen can say what actually happened.
function userReply(a, text, replyToId) {
  if (!a) return { ok: false, code: "no_appeal" };
  if (a.status !== "open") return { ok: false, code: "closed" };
  if (a.locked) return { ok: false, code: "locked" };
  const body = String(text || "").trim().slice(0, MSG_MAX);
  if (body.length < 2) return { ok: false, code: "too_short" };
  const mine = a.messages.filter((m) => m.from === "user");
  if (mine.length >= USER_MSG_CAP) return { ok: false, code: "too_many" };
  const last = mine[mine.length - 1];
  if (last && Date.now() - last.ts < USER_COOLDOWN_MS)
    return { ok: false, code: "slow_down" };
  const m = pushMessage(a, {
    from: "user",
    text: body,
    ...(replySnapshot(a, replyToId)
      ? { reply: replySnapshot(a, replyToId) }
      : {}),
  });
  return { ok: true, message: m };
}

// A moderator writes. Their label, rank and picture go on the message: the
// person reading it is banned and anxious, and "Staff" with no face is how you
// get somebody arguing with what they assume is a bot. It is stamped onto the
// message rather than looked up later, so it still reads correctly after they
// change their picture or hand the key back.
function staffReply(a, text, who, replyToId) {
  if (!a) return { ok: false, code: "no_appeal" };
  const body = String(text || "").trim().slice(0, MSG_MAX);
  if (!body) return { ok: false, code: "too_short" };
  const w = typeof who === "string" ? { label: who } : who || {};
  const m = pushMessage(a, {
    from: "staff",
    by: w.label || "staff",
    role: w.role === "dev" ? "dev" : "mod",
    level: w.role === "dev" ? 0 : w.level === 1 ? 1 : 2,
    ...(w.avatar && w.avatar.id && w.avatar.hash
      ? { avatar: { id: String(w.avatar.id), hash: String(w.avatar.hash) } }
      : {}),
    text: body,
    ...(replySnapshot(a, replyToId)
      ? { reply: replySnapshot(a, replyToId) }
      : {}),
  });
  return { ok: true, message: m };
}

// A line written by the server itself: chat ended, ban lifted, appeal
// dismissed. It reads the same to both sides.
function systemNote(a, text) {
  if (!a) return null;
  return pushMessage(a, { from: "system", text: String(text).slice(0, 200) });
}

// End (or reopen) the chat without deciding the appeal.
function setLocked(id, locked, byLabel) {
  const a = get(id);
  if (!a) return null;
  a.locked = !!locked;
  a.lockedBy = locked ? byLabel || null : null;
  a.lockedAt = locked ? Date.now() : null;
  systemNote(
    a,
    locked
      ? "This chat was ended by staff. Your appeal is still being reviewed."
      : "Staff reopened this chat.",
  );
  saveSoon();
  return a;
}

// Resolve one appeal (staff lifted the ban, or dismissed the appeal). The
// decision is written into the conversation too, so the user reads it in the
// same place they have been talking.
function resolve(id, resolution, reviewedBy, note) {
  const a = get(id);
  if (!a) return null;
  a.status = "resolved";
  a.resolution = resolution || "dismissed";
  a.reviewedBy = reviewedBy || null;
  a.reviewedAt = Date.now();
  systemNote(
    a,
    a.resolution === "lifted"
      ? "Your ban has been lifted." + (note ? " " + note : "")
      : "This appeal was declined and the ban stays in place." +
          (note ? " " + note : ""),
  );
  saveSoon();
  return a;
}

// Mark every open appeal for an IP resolved (used when the ban is lifted by
// another path, e.g. a dev unblocks the IP from the Ban list, so the appeal
// inbox does not keep a stale "open" appeal for an IP that is no longer banned).
function resolveOpenForIp(ip, resolution, reviewedBy) {
  let n = 0;
  const now = Date.now();
  for (const a of appeals)
    if (a.ip === ip && a.status === "open") {
      a.status = "resolved";
      a.resolution = resolution || "lifted";
      a.reviewedBy = reviewedBy || null;
      a.reviewedAt = now;
      systemNote(
        a,
        a.resolution === "lifted"
          ? "Your ban has been lifted."
          : "This appeal was closed.",
      );
      n++;
    }
  if (n) saveSoon();
  return n;
}

// Same as resolveOpenForIp, but keyed on the appellant's device identifier.
// Used when an "id:" block is lifted from the ban list.
function resolveOpenForDevice(deviceId, resolution, reviewedBy) {
  let n = 0;
  const now = Date.now();
  const low = String(deviceId || "").toLowerCase();
  if (!low) return 0;
  for (const a of appeals)
    if (a.deviceId === low && a.status === "open") {
      a.status = "resolved";
      a.resolution = resolution || "lifted";
      a.reviewedBy = reviewedBy || null;
      a.reviewedAt = now;
      systemNote(
        a,
        a.resolution === "lifted"
          ? "Your ban has been lifted."
          : "This appeal was closed.",
      );
      n++;
    }
  if (n) saveSoon();
  return n;
}

function openCount() {
  return appeals.reduce((n, a) => n + (a.status === "open" ? 1 : 0), 0);
}

// Newest first. The caller decides whether to include the IP (dev-only).
function list() {
  return appeals.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
}

load();

module.exports = {
  submit,
  get,
  forUser,
  userReply,
  staffReply,
  systemNote,
  setLocked,
  resolve,
  resolveOpenForIp,
  resolveOpenForDevice,
  openForIp,
  openCount,
  list,
  flushSync,
  MSG_MAX,
  USER_MSG_CAP,
};
