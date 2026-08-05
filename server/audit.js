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

// IP addresses are dev-only. Mods get every field except the raw addresses.
function redactForMod(entry) {
  if (entry.ip == null && entry.targetIp == null) return entry;
  const copy = Object.assign({}, entry);
  delete copy.ip;
  delete copy.targetIp;
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
// `ip` is whoever raised it, `targetIp` whoever it is about. Both are stripped
// for mods by redactForMod, same as anywhere else, but recording them means a
// dev reading a report in the feed does not have to go and look them up.
function recordNotification({
  kind, label, role, text, target, room, by, minLevel,
  ip, targetIp, targetUserId, byUserId, reports, byRole, targetRole,
}) {
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
    byUserId: byUserId || null,
    targetUserId: targetUserId || null,
    // Staff status as the server knows it, so the board never has to guess
    // from a username. Explicitly null when they are an ordinary user.
    byRole: byRole || null,
    targetRole: targetRole || null,
    ip: ip || null,
    targetIp: targetIp || null,
    reports: reports || null,
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

// The last `n` Pacific midnights, oldest first, ending with today's. Each one
// is resolved on its own rather than by subtracting 24h repeatedly, so the two
// daylight-saving switchover days do not drag the whole week an hour out.
const DAY_MS = 24 * 60 * 60 * 1000;
function pacificDayStarts(n = 7, now = Date.now()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const start = startOfPacificDay(now - i * DAY_MS);
    if (!out.length || start !== out[out.length - 1]) out.push(start);
  }
  return out;
}

function recent(limit = 500, includeIp = true, modLevel = 2, since = 0) {
  const n = Math.max(1, Number(limit) || 500);
  let slice;
  if (since > 0) {
    // Walk back from the newest entry until we leave the window or hit the
    // cap, so a long history is never copied wholesale just to be filtered
    // away. This runs on every dashboard connect.
    let i = entries.length - 1;
    let taken = 0;
    while (i >= 0 && (entries[i].ts || 0) >= since && taken < n) {
      i--;
      taken++;
    }
    slice = entries.slice(i + 1);
  } else {
    slice = entries.slice(-n);
  }
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

// Which bucket an action belongs to. "passive" is deliberately separate: it is
// things a staff member did that are not moderation work (watching a room,
// unlocking the panel), so counting them towards someone's workload would make
// a lurker look busier than a moderator who actually clears queues.
const ACTION_GROUPS = [
  {
    key: "enforcement",
    label: "Acting on users",
    match: /^(kick|kick\+ban|ban|ip block|ban ip|unblock ip|warn|wipe buffer|rename|reset location|turn pfp off|allow pfp|freeze|force kick)/,
  },
  {
    key: "reviews",
    label: "Clearing queues",
    match: /^(dismiss report|approve mod application|reject mod application|review application|dismiss appeal|lift ban|approve suggestion|decline suggestion|purge invites|undo invite purge)/,
  },
  {
    key: "rooms",
    label: "Looking after rooms",
    match: /^(lock room|unlock room|slow mode|close room|rename room|clear board|spotlight|set room size|wipe)/,
  },
  {
    key: "records",
    label: "Record keeping",
    match: /^(set note|clear note|set block message|set block duration)/,
  },
  {
    key: "admin",
    label: "Server and roles",
    match: /^(grant mod|revoke mod|set mod level|megaphone|party|ticker|maintenance|flag|nuke|clear blacklist)/,
  },
  {
    key: "passive",
    label: "Not counted as work",
    match: /^(spectate|unspectate|staff key entered|staff login|staff logout)/,
  },
];

function groupOf(action) {
  const a = baseAction(action);
  for (const g of ACTION_GROUPS) if (g.match.test(a)) return g.key;
  return "enforcement"; // an unrecognised staff action is still real work
}

// Anything that is not passive counts towards a moderator's workload.
function isUsefulAction(action) {
  return groupOf(action) !== "passive";
}

const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// One staff member's record. The tallies are lifetime and never move; the
// listed entries cover the last 30 days only and are paged, so a moderator
// with tens of thousands of actions cannot hang the page.
function historyFor(label, role, opts = {}) {
  const want = String(label || "");
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
  if (!want)
    return {
      label: want, total: 0, useful: 0, counts: [], groups: [],
      entries: [], offset, limit, windowTotal: 0, windowDays: 30,
    };

  const counts = new Map();
  const groupTotals = new Map();
  const recent = [];
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  let total = 0;
  let useful = 0;
  let first = null;
  let last = null;

  for (const e of entries) {
    if (e.type !== "action") continue;
    if (e.label !== want) continue;
    if (role && e.role && e.role !== role) continue;
    total++;
    if (first == null) first = e.ts;
    last = e.ts;
    const a = baseAction(e.action);
    counts.set(a, (counts.get(a) || 0) + 1);
    const g = groupOf(e.action);
    groupTotals.set(g, (groupTotals.get(g) || 0) + 1);
    if (g !== "passive") useful++;
    if ((e.ts || 0) >= cutoff) recent.push(e);
  }

  recent.reverse(); // newest first
  const groups = ACTION_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    n: groupTotals.get(g.key) || 0,
    actions: [...counts.entries()]
      .filter(([a]) => groupOf(a) === g.key)
      .map(([action, n]) => ({ action, n }))
      .sort((a, b) => b.n - a.n),
  })).filter((g) => g.n > 0);

  return {
    label: want,
    role: role || null,
    total,
    useful,
    first,
    last,
    groups,
    counts: [...counts.entries()]
      .map(([action, n]) => ({ action, n }))
      .sort((a, b) => b.n - a.n),
    windowDays: 30,
    windowTotal: recent.length,
    offset,
    limit,
    entries: recent.slice(offset, offset + limit),
  };
}

// Every staff member's workload in one pass, for the leaderboard and for
// spotting a junior who has earned a look at promotion.
function leaderboard() {
  const by = new Map(); // "role:label" -> stats
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  for (const e of entries) {
    if (e.type !== "action" || !e.label) continue;
    const key = (e.role || "mod") + ":" + e.label;
    let s = by.get(key);
    if (!s) {
      s = {
        label: e.label, role: e.role || "mod",
        total: 0, useful: 0, recentUseful: 0,
        enforcement: 0, reviews: 0, rooms: 0, last: null,
      };
      by.set(key, s);
    }
    s.total++;
    s.last = e.ts;
    const g = groupOf(e.action);
    if (g !== "passive") {
      s.useful++;
      if ((e.ts || 0) >= cutoff) s.recentUseful++;
    }
    if (g === "enforcement") s.enforcement++;
    else if (g === "reviews") s.reviews++;
    else if (g === "rooms") s.rooms++;
  }
  return [...by.values()].sort((a, b) => b.useful - a.useful);
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
  leaderboard,
  isUsefulAction,
  startOfPacificDay,
  pacificDayStarts,
  setAuditSub,
  load,
};
