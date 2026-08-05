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
//
// The bracket is cut from the first "(" to the end rather than matched as a
// pair: room and user names contain brackets of their own, so a paired match on
// `rename room (was Ha(ha))` left a stray ")" behind and split one action into
// two separate tallies.
function baseAction(action) {
  return String(action || "?")
    .replace(/\s*\([\s\S]*$/, "")
    .replace(/\s+(1h|24h|7d|permanent)\b/gi, "")
    .replace(/\s+L\d+\b/gi, "")
    .replace(/\s+\d+$/, "")
    .trim()
    .toLowerCase();
}

// Which bucket an action belongs to.
//
// Membership is by exact action name, not by prefix. Prefix matching used to
// file `rename room` under "Acting on users" because the list had `rename` in
// it, which quietly inflated the one number promotion is judged on: a mod who
// renamed rooms all day read as a mod who had handled people all day.
//
// "passive" is deliberately separate: watching a room or unlocking the panel is
// not moderation work, and counting it would make a lurker look busier than
// somebody actually answering reports.
const ACTION_GROUPS = [
  {
    key: "users",
    label: "Acting on users",
    blurb: "Landed on a person. This is what moderating actually is.",
    actions: [
      "kick", "kick+ban", "wipe buffer", "warn",
      "ban", "ban ip", "ip block", "unblock ip",
      "rename", "reset location", "turn pfp off", "allow pfp",
      "freeze", "unfreeze", "piano mute", "piano unmute",
    ],
  },
  {
    key: "queues",
    label: "Clearing queues",
    blurb: "Worked through reports, appeals, applications and suggestions.",
    actions: [
      "dismiss report", "dismiss appeal", "lift ban",
      "approve mod application", "reject mod application", "review application",
      "approve suggestion", "decline suggestion",
      "suggestion approved", "suggestion declined", "suggestion done",
      "delete board post", "delete board reply",
      "purge invites", "undo invite purge",
      "open applications", "close applications",
    ],
  },
  {
    key: "rooms",
    label: "Looking after rooms",
    blurb: "Tidied a room. Useful, but nobody was moderated.",
    actions: [
      "lock room", "unlock room", "slow mode on", "slow mode off",
      "close room", "rename room", "clear board",
      "spotlight on", "spotlight off", "set room size", "party mode",
    ],
  },
  {
    key: "records",
    label: "Record keeping",
    blurb: "Notes and block copy. Bookkeeping, not enforcement.",
    actions: [
      "set note", "clear note", "set block message", "set block duration",
    ],
  },
  {
    key: "admin",
    label: "Server and roles",
    blurb: "Server-wide switches and staff roles.",
    actions: [
      "grant mod", "revoke mod", "set mod level", "grant mod to user",
      "set mod level for user", "revoke mod from user",
      "megaphone", "set ticker", "maintenance on", "maintenance off",
      "set flags", "nuke all rooms", "clear blacklist",
    ],
  },
  {
    key: "passive",
    label: "Not counted as work",
    blurb: "Watching and signing in. Real, but not a workload.",
    actions: ["spectate", "unspectate", "staff key entered", "staff login", "staff logout"],
  },
];

// baseAction -> group key, built once.
const GROUP_BY_ACTION = new Map();
for (const g of ACTION_GROUPS)
  for (const a of g.actions) GROUP_BY_ACTION.set(a, g.key);

const GROUP_LABEL = new Map(ACTION_GROUPS.map((g) => [g.key, g.label]));

// Anything new that has not been added to a bucket yet. Kept out of "Acting on
// users" on purpose: an unrecognised action must never silently pad the number
// a promotion is decided on.
function groupOf(action) {
  return GROUP_BY_ACTION.get(baseAction(action)) || "other";
}

// The three actions a junior moderator has, and the only ones they can use to
// build a record. Broken out so the record can say plainly how much of somebody
// is the day-to-day job rather than the powers that came with a level.
const CORE_USER_ACTIONS = new Set(["kick", "wipe buffer", "warn"]);

// Anything that is not passive counts as something happening. It is NOT the
// promotion number - see onUsers in historyFor.
function isUsefulAction(action) {
  return groupOf(action) !== "passive";
}

// Switches that can be flipped back and forth. Flipping one and immediately
// flipping it back is two log lines and zero moderation, so a record full of
// them is the clearest sign somebody is padding a total.
const TOGGLE_PAIRS = new Map([
  ["lock room", "unlock room"],
  ["unlock room", "lock room"],
  ["slow mode on", "slow mode off"],
  ["slow mode off", "slow mode on"],
  ["spotlight on", "spotlight off"],
  ["spotlight off", "spotlight on"],
  ["freeze", "unfreeze"],
  ["unfreeze", "freeze"],
  ["turn pfp off", "allow pfp"],
  ["allow pfp", "turn pfp off"],
  ["piano mute", "piano unmute"],
  ["piano unmute", "piano mute"],
  ["maintenance on", "maintenance off"],
  ["maintenance off", "maintenance on"],
]);

const TOGGLE_WINDOW_MS = 2 * 60 * 1000; // undone within two minutes
const REPEAT_WINDOW_MS = 10 * 60 * 1000; // same thing, same person, again
const RAPID_GAP_MS = 5 * 1000; // back-to-back, faster than reading a room

// Pull the display name and id back out of the "user:Name(id)" / "room:Name(id)"
// strings logStaff writes. Names can contain brackets, so anchor on the LAST
// "(" rather than the first.
function splitTag(tag, prefix) {
  const s = String(tag || "");
  if (!s.startsWith(prefix)) return null;
  const body = s.slice(prefix.length);
  const open = body.lastIndexOf("(");
  const close = body.lastIndexOf(")");
  if (open === -1 || close < open) return { name: body, id: null };
  return { name: body.slice(0, open), id: body.slice(open + 1, close) };
}

const parseUserTag = (t) => splitTag(t, "user:");
const parseRoomTag = (t) => splitTag(t, "room:");

const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// How much work on actual users a junior should have behind them before a
// developer is asked to look at full mod. It is a prompt to go and read the
// record, never an entitlement, and only actions in the "users" group count -
// renaming rooms and writing notes cannot carry somebody to it.
const PROMOTION_AT = 1000;

// Reads a staff member's whole record and works out both what they did and
// whether the shape of it should worry anybody.
//
// The tallies are lifetime and never move. The listed entries cover the last 30
// days, are filterable by group or by who they landed on, and are paged, so a
// moderator with tens of thousands of actions cannot hang the page.
function historyFor(label, role, opts = {}) {
  const want = String(label || "");
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
  const wantGroup = opts.group ? String(opts.group) : null;
  const wantTarget = opts.targetUid ? String(opts.targetUid) : null;
  const empty = {
    label: want, role: role || null, total: 0, useful: 0, onUsers: 0, core: 0,
    counts: [], groups: [], targets: [], flags: [], entries: [],
    offset, limit, windowTotal: 0, windowMatched: 0, windowDays: 30,
    promotionAt: PROMOTION_AT, group: wantGroup, targetUid: wantTarget,
  };
  if (!want) return empty;

  const counts = new Map();
  const groupTotals = new Map();
  const targets = new Map(); // uid -> { uid, name, n, actions: Map }
  const recent = [];
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  let total = 0;
  let useful = 0;
  let onUsers = 0;
  let core = 0;
  let first = null;
  let last = null;

  // Abuse-shape counters, all built in the same pass.
  const history = []; // { ts, base, group, targetId, roomId, used }
  let rapid = 0;
  let repeats = 0;
  let togglePairs = 0;
  let kicks = 0;
  let warns = 0;
  let prevTs = null;

  for (const e of entries) {
    if (e.type !== "action") continue;
    if (e.label !== want) continue;
    if (role && e.role && e.role !== role) continue;

    total++;
    if (first == null) first = e.ts;
    last = e.ts;

    const base = baseAction(e.action);
    const group = groupOf(e.action);
    counts.set(base, (counts.get(base) || 0) + 1);
    groupTotals.set(group, (groupTotals.get(group) || 0) + 1);
    if (group !== "passive") useful++;
    if (group === "users") {
      onUsers++;
      if (CORE_USER_ACTIONS.has(base)) core++;
    }
    if (base === "kick" || base === "kick+ban") kicks++;
    if (base === "warn") warns++;

    const tgt = parseUserTag(e.target);
    const room = parseRoomTag(e.room);
    const ts = e.ts || 0;

    // Who they have actually pointed their powers at.
    if (group === "users" && tgt) {
      const key = tgt.id || "name:" + tgt.name;
      let t = targets.get(key);
      if (!t) {
        t = { uid: tgt.id || null, name: tgt.name, n: 0, actions: new Map() };
        targets.set(key, t);
      }
      t.name = tgt.name; // keep the most recent name they were logged under
      t.n++;
      t.actions.set(base, (t.actions.get(base) || 0) + 1);
    }

    // Back-to-back actions, faster than anybody could have read the room.
    if (group !== "passive" && prevTs != null && ts - prevTs < RAPID_GAP_MS)
      rapid++;
    if (group !== "passive") prevTs = ts;

    const rec = {
      ts,
      base,
      group,
      targetId: tgt ? tgt.id || tgt.name : null,
      roomId: room ? room.id || room.name : null,
      used: false,
    };

    // The same thing, to the same person, again within ten minutes.
    if (group === "users" && rec.targetId) {
      for (let i = history.length - 1; i >= 0; i--) {
        const p = history[i];
        if (ts - p.ts > REPEAT_WINDOW_MS) break;
        if (p.base === base && p.targetId === rec.targetId) {
          repeats++;
          break;
        }
      }
    }

    // A switch flipped and flipped straight back on the same room or person.
    const opposite = TOGGLE_PAIRS.get(base);
    if (opposite) {
      const scope = rec.roomId || rec.targetId;
      for (let i = history.length - 1; i >= 0; i--) {
        const p = history[i];
        if (ts - p.ts > TOGGLE_WINDOW_MS) break;
        if (p.used || p.base !== opposite) continue;
        if ((p.roomId || p.targetId) !== scope) continue;
        p.used = true;
        rec.used = true;
        togglePairs++;
        break;
      }
    }

    history.push(rec);
    if (history.length > 4000) history.shift();

    if (ts >= cutoff) recent.push({ ...e, base, group });
  }

  recent.reverse(); // newest first

  const groups = ACTION_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    blurb: g.blurb,
    n: groupTotals.get(g.key) || 0,
    actions: [...counts.entries()]
      .filter(([a]) => groupOf(a) === g.key)
      .map(([action, n]) => ({ action, n }))
      .sort((a, b) => b.n - a.n),
  })).filter((g) => g.n > 0);

  // Anything the buckets above do not know about yet, so a new action is
  // visible in the record instead of disappearing.
  const otherActions = [...counts.entries()]
    .filter(([a]) => groupOf(a) === "other")
    .map(([action, n]) => ({ action, n }))
    .sort((a, b) => b.n - a.n);
  if (otherActions.length)
    groups.push({
      key: "other",
      label: "Not yet classified",
      blurb: "New actions that have not been sorted into a bucket.",
      n: otherActions.reduce((s, c) => s + c.n, 0),
      actions: otherActions,
    });

  const topTargets = [...targets.values()]
    .sort((a, b) => b.n - a.n)
    .map((t) => ({
      uid: t.uid,
      name: t.name,
      n: t.n,
      actions: [...t.actions.entries()]
        .map(([action, n]) => ({ action, n }))
        .sort((a, b) => b.n - a.n),
    }));

  const filtered = recent.filter((e) => {
    if (wantGroup && e.group !== wantGroup) return false;
    if (wantTarget) {
      const t = parseUserTag(e.target);
      if (!t || (t.id || t.name) !== wantTarget) return false;
    }
    return true;
  });

  return {
    label: want,
    role: role || null,
    total,
    useful,
    onUsers,
    core,
    passive: groupTotals.get("passive") || 0,
    first,
    last,
    groups,
    targets: topTargets.slice(0, 10),
    distinctTargets: targets.size,
    flags: buildFlags({
      total, useful, onUsers, kicks, warns, rapid, repeats, togglePairs,
      targets: topTargets, groupTotals,
    }),
    promotionAt: PROMOTION_AT,
    counts: [...counts.entries()]
      .map(([action, n]) => ({ action, n }))
      .sort((a, b) => b.n - a.n),
    windowDays: 30,
    windowTotal: recent.length,
    windowMatched: filtered.length,
    group: wantGroup,
    targetUid: wantTarget,
    offset,
    limit,
    entries: filtered.slice(offset, offset + limit),
  };
}

// Turns the shape counters into plain sentences. These are prompts to go and
// read the log, not verdicts: every one of them has an innocent explanation,
// and the point is that somebody looks rather than that the number is trusted.
function buildFlags(s) {
  const out = [];
  const add = (key, level, title, detail) =>
    out.push({ key, level, title, detail });
  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

  const roomish =
    (s.groupTotals.get("rooms") || 0) + (s.groupTotals.get("users") || 0);
  if (s.togglePairs >= 3) {
    const share = pct(s.togglePairs * 2, roomish);
    add(
      "toggles",
      s.togglePairs >= 10 ? "watch" : "note",
      s.togglePairs + " switches flipped and flipped straight back",
      "Locking a room and unlocking it seconds later is two entries in the log and no moderation. " +
        (share >= 10 ? "That is about " + share + "% of their room and user actions. " : "") +
        "Worth a look if their total is what is being judged.",
    );
  }

  if (s.repeats >= 10)
    add(
      "repeats",
      s.repeats >= 25 ? "watch" : "note",
      s.repeats + " repeats of the same action on the same person",
      "The same power used on one person again inside ten minutes. Sometimes that is somebody who came straight back; a lot of it is somebody leaning on one user.",
    );

  if (s.rapid >= 10 && pct(s.rapid, s.useful) >= 25)
    add(
      "rapid",
      pct(s.rapid, s.useful) >= 40 ? "watch" : "note",
      pct(s.rapid, s.useful) + "% of their actions came within 5 seconds of the last one",
      "Bursts this tight usually mean a toolbar being clicked through rather than decisions being made one at a time.",
    );

  const top = s.targets && s.targets[0];
  if (top && s.onUsers >= 10 && pct(top.n, s.onUsers) >= 40)
    add(
      "focus",
      pct(top.n, s.onUsers) >= 60 ? "watch" : "note",
      pct(top.n, s.onUsers) + "% of everything they did to a user landed on " + top.name,
      "One person taking most of a moderator's attention is either a genuinely persistent problem user or a grudge. The log says which.",
    );

  if (s.kicks >= 10 && s.warns === 0)
    add(
      "nowarn",
      "note",
      s.kicks + " kicks and not one warning",
      "Nobody was told what they did wrong before being removed.",
    );

  if (s.onUsers === 0 && s.useful >= 40)
    add(
      "nousers",
      "note",
      "No actions on users at all",
      s.useful +
        " logged actions, none of which landed on a person. This is a record built entirely out of rooms, notes and settings.",
    );

  return out;
}

// Every staff member's workload in one pass, for the leaderboard and for
// spotting a junior who has earned a look at promotion. The ranking is by work
// done on users, so a record padded with room tidying does not climb it.
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
        total: 0, useful: 0, recentUseful: 0, onUsers: 0, recentOnUsers: 0,
        queues: 0, rooms: 0, records: 0, passive: 0, last: null,
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
    if (g === "users") {
      s.onUsers++;
      if ((e.ts || 0) >= cutoff) s.recentOnUsers++;
    } else if (g === "queues") s.queues++;
    else if (g === "rooms") s.rooms++;
    else if (g === "records") s.records++;
    else if (g === "passive") s.passive++;
  }
  return [...by.values()].sort(
    (a, b) => b.onUsers - a.onUsers || b.useful - a.useful,
  );
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
  PROMOTION_AT,
  startOfPacificDay,
  pacificDayStarts,
  setAuditSub,
  load,
};
