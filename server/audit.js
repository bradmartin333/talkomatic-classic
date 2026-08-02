// server/audit.js
// Accountability log. Records two kinds of events for the staff board
// (mod.html), keeps an in-memory ring buffer for fast reads, persists to
// audit-log.jsonl, and live-broadcasts to subscribed staff sockets:
//
//   type "action"   - a privileged staff action (who, what, target, room, IP)
//   type "identity" - a user signing in or changing their username (IP +
//                     old/new name) so any name can always be traced back
//
// Staff actions are ALSO mirrored to the human-readable modlog.txt (the file
// named in the v4 spec) for plain forensics.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { state } = require("./state");

const { DATA_DIR } = require("./datadir");

const AUDIT_PATH = path.join(DATA_DIR, "audit-log.jsonl");
const MODLOG_PATH = path.join(DATA_DIR, "modlog.txt");

let entries = []; // append-only history, oldest first
let seq = 0;
// userId -> { username, location } - last known identity, to detect changes
const lastIdentity = new Map();

function io() {
  return state.io;
}

// IP addresses are dev-only. Mods get every field except the raw IP.
function redactForMod(entry) {
  if (entry.ip == null) return entry;
  const copy = Object.assign({}, entry);
  delete copy.ip;
  return copy;
}

function broadcast(entry) {
  if (!io()) return;
  const masked = redactForMod(entry);
  for (const [, s] of io().sockets.sockets) {
    if (!s.auditSub) continue;
    if (s.isDev) {
      s.emit("audit entry", entry);
      continue;
    }
    if (!s.isMod) continue;
    // Key security alerts concern dev/mod keys and IPs, so they are dev-only.
    if (entry.devOnly) continue;
    // Some entries (mod-abuse flags, reports) are for full (level 2) mods +.
    if (entry.minLevel && (s.modLevel || 2) < entry.minLevel) continue;
    s.emit("audit entry", masked);
  }
}

let writeChain = Promise.resolve();

function enqueueWrite(fn) {
  writeChain = writeChain
    .then(fn)
    .catch((e) => console.error("audit io failed:", e));
  return writeChain;
}

function persist(entry) {
  enqueueWrite(async () => {
    await fsp.appendFile(AUDIT_PATH, JSON.stringify(entry) + "\n");
  });
}

function push(entry) {
  entry.id = ++seq;
  entries.push(entry);
  persist(entry);
  broadcast(entry);
  return entry;
}

// A privileged staff action. Mirrors one line to modlog.txt.
function recordAction({ roleTag, label, action, target, room, ip, details }) {
  const ts = Date.now();
  push({
    ts,
    type: "action",
    role: roleTag || "?",
    label: label || roleTag || "?",
    action: action || "?",
    target: target || null,
    room: room || null,
    ip: ip || null,
    details: details || null,
  });
  const line =
    [
      new Date(ts).toISOString(),
      `${roleTag || "?"}:${label || roleTag || "?"}`,
      action || "?",
      target || "-",
      room || "-",
      details ? `(${details})` : "",
    ]
      .join(" | ")
      .trimEnd() + "\n";
  fsp.appendFile(MODLOG_PATH, line).catch(() => {});
}

// A user picking or changing their displayed identity. Deduped: no entry if
// nothing changed. `event` is "signin" the first time, "rename" on a change.
function recordIdentity({ userId, username, location, ip }) {
  if (!userId || !username) return;
  const prev = lastIdentity.get(userId);
  let event = "signin";
  let prevUsername = null;
  let prevLocation = null;
  if (prev) {
    if (prev.username === username && prev.location === location) return;
    event = "rename";
    prevUsername = prev.username;
    prevLocation = prev.location;
  }
  lastIdentity.set(userId, { username, location });
  push({
    ts: Date.now(),
    type: "identity",
    event,
    userId,
    username,
    location: location || null,
    prevUsername,
    prevLocation,
    ip: ip || null,
  });
}

// Staff forced a user's name to Anonymous - log it and reset the baseline.
function recordForcedRename({ userId, from, ip, by, room }) {
  const prevLoc = lastIdentity.get(userId)?.location || null;
  lastIdentity.set(userId, { username: "Anonymous", location: prevLoc });
  push({
    ts: Date.now(),
    type: "identity",
    event: "forced-rename",
    userId,
    username: "Anonymous",
    prevUsername: from || null,
    location: prevLoc,
    ip: ip || null,
    by: by || null,
    room: room || null,
  });
}

// A staff-key security alert: a dev/mod key used from an IP it has never
// connected from, or active from multiple IPs at once. These are the signals
// of a shared or leaked key. Dev-only (involves keys + raw IPs).
function recordKeyAlert({ role, label, ip, kind, detail }) {
  push({
    ts: Date.now(),
    type: "security",
    devOnly: true,
    role: role || "?",
    label: label || role || "?",
    kind: kind || "alert", // "new-ip" | "concurrent"
    ip: ip || null,
    detail: detail || null,
  });
}

// A staff notification: a user report, or a possible mod-abuse flag. Shown in
// the dashboard feed AND pushed as a live toast to qualifying staff so it isn't
// missed. Default visibility is full (level 2) mods + devs; never junior mods.
function recordNotification({ kind, label, role, text, target, room, by, minLevel }) {
  const lvl = minLevel === 1 ? 1 : 2;
  const entry = push({
    ts: Date.now(),
    type: "notification",
    minLevel: lvl,
    kind: kind || "notice",
    role: role || null,
    label: label || null,
    text: text || null,
    target: target || null,
    room: room || null,
    by: by || null,
  });
  notifyStaffToast(text || "New staff notification", lvl);
  return entry;
}

// Live toast to qualifying staff regardless of whether the dashboard is open,
// so reports and abuse flags surface even to staff sitting in a room or lobby.
function notifyStaffToast(text, minLevel) {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets) {
    if (s.isDev) {
      s.emit("staff notice", { text });
      continue;
    }
    if (s.isMod && (s.modLevel || 2) >= (minLevel || 2))
      s.emit("staff notice", { text });
  }
}

// A staff comment attached to an existing log entry (discussion / "why?").
function recordComment({ entryId, role, label, text, ip }) {
  if (!entryId || !text) return;
  push({
    ts: Date.now(),
    type: "comment",
    refId: entryId,
    role: role || "mod",
    label: label || role || "mod",
    text,
    ip: ip || null,
  });
}

// Midnight in Los Angeles, as a UTC timestamp. The dashboard shows one Pacific
// day at a time so every staff member is looking at the same window whatever
// timezone they are in. Uses Intl rather than a fixed offset so the switch
// between PST and PDT is handled for us.
const PACIFIC_FMT = (() => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch (_) {
    return null;
  }
})();

function startOfPacificDay(now = Date.now()) {
  if (!PACIFIC_FMT) return 0; // no Intl: show everything rather than nothing
  try {
    const partsAt = (t) =>
      PACIFIC_FMT.formatToParts(new Date(t)).reduce(
        (a, p) => ((a[p.type] = p.value), a),
        {},
      );
    // How far the Pacific wall clock sits from UTC at a given instant.
    const offsetAt = (t) => {
      const p = partsAt(t);
      return (
        Date.UTC(
          +p.year,
          +p.month - 1,
          +p.day,
          +p.hour,
          +p.minute,
          +p.second,
        ) -
        Math.floor(t / 1000) * 1000
      );
    };
    const today = partsAt(now);
    const localMidnight = Date.UTC(+today.year, +today.month - 1, +today.day);
    // Convert local midnight to a real instant. The offset can change during
    // the day (the two DST switchovers), so resolve with the offset that is
    // actually in force at midnight, not the one in force right now.
    let guess = localMidnight - offsetAt(now);
    guess = localMidnight - offsetAt(guess);
    return guess;
  } catch (_) {
    return 0;
  }
}

function recent(limit = 500, includeIp = true, modLevel = 2, since = 0) {
  const n = Math.max(1, Number(limit) || 500);
  let slice = entries.slice(-n);
  if (since > 0) slice = slice.filter((e) => (e.ts || 0) >= since);
  // Devs see everything; mods get IP-redacted entries with dev-only ones and
  // anything above their level removed.
  if (includeIp) return slice;
  return slice
    .filter((e) => !e.devOnly && (!e.minLevel || modLevel >= e.minLevel))
    .map(redactForMod);
}

// Action strings carry their parameters ("ip block 24h", "rename (was Bob)",
// "grant mod L1"). Strip those so the per-moderator tally groups the same kind
// of action together instead of splitting it across every variation.
function baseAction(action) {
  return String(action || "?")
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+(1h|24h|7d|permanent)\b/gi, "")
    .replace(/\s+L\d\b/g, "")
    .trim()
    .toLowerCase();
}

// Everything one staff member has ever done, newest first, with a tally per
// kind of action. Visible to all staff: the point is that moderators can be
// held to account by their peers, not just by devs.
function historyFor(label, role, limit = 500) {
  const want = String(label || "");
  if (!want) return { label: want, total: 0, counts: [], entries: [] };
  const mine = [];
  const counts = new Map();
  for (const e of entries) {
    if (e.type !== "action") continue;
    if (e.label !== want) continue;
    if (role && e.role && e.role !== role) continue;
    mine.push(e);
    const k = baseAction(e.action);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const n = Math.max(1, Math.min(Number(limit) || 500, 2000));
  return {
    label: want,
    role: role || null,
    total: mine.length,
    first: mine.length ? mine[0].ts : null,
    last: mine.length ? mine[mine.length - 1].ts : null,
    counts: [...counts.entries()]
      .map(([action, n2]) => ({ action, n: n2 }))
      .sort((a, b) => b.n - a.n),
    entries: mine.slice(-n).reverse(),
  };
}

function setAuditSub(socket, on) {
  if (socket) socket.auditSub = !!on;
}

// Hydrate the ring buffer (and identity baselines) from disk at boot.
function load() {
  try {
    const raw = fs.readFileSync(AUDIT_PATH, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    entries = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    seq = entries.reduce((m, e) => Math.max(m, e.id || 0), 0);
    for (const e of entries) {
      if (e.type === "identity" && e.userId)
        lastIdentity.set(e.userId, {
          username: e.username,
          location: e.location,
        });
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("audit load failed:", err);
    entries = [];
  }
}

load();

module.exports = {
  recordAction,
  recordIdentity,
  recordForcedRename,
  recordKeyAlert,
  recordNotification,
  recordComment,
  recent,
  historyFor,
  startOfPacificDay,
  setAuditSub,
  load,
};
