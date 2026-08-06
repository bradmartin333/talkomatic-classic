// server/staffchat.js
// The Desk: staff-only chat and shift console. Channels, threads, presence,
// and @mod/@dev pings raised from a room textbox. Everything here is for
// people who already hold a staff key; a normal user never learns it exists.
//
// Two rules are load-bearing and must survive any edit:
//  - Nothing in this file calls logStaff or feeds the audit action log. Chat
//    is not moderation work, and the leaderboard was just made hard to pad.
//  - Identity at the Desk is the staff key label. Hiding a flair or vanishing
//    conceals someone from USERS, never from other staff in here.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const { DATA_DIR } = require("./datadir");

const FILE = path.join(DATA_DIR, "staff-chat.json");

// ── Channels ────────────────────────────────────────────────────────────────
// #queues carries the same cards the notification feed gets: reports,
// appeals, applications, suggestions, abuse flags. The review queues are
// full-mod work everywhere else on the site, so the channel is L2+ too, and
// each card still carries its own audience level from the feed.
const CHANNELS = [
  { key: "floor", name: "floor", desc: "Day to day. The default." },
  { key: "help", name: "help", desc: "Live calls for backup from rooms." },
  { key: "queues", name: "queues", desc: "Incoming reports, appeals, applications.", access: "l2" },
  { key: "l2", name: "l2", desc: "Bans, blocks, escalations.", access: "l2" },
  { key: "devs", name: "devs", desc: "Keys, promotions, mod abuse.", access: "dev" },
  // Posted to by the server at the end of each day. Nobody types in here.
  { key: "stats", name: "stats", desc: "How yesterday went.", readonly: true },
];

const MSG_MAX = 1200;
const CHANNEL_CAP = 1500; // messages kept per channel
const THREAD_MSG_CAP = 800;
const ARCHIVED_CAP = 300; // archived threads kept
const EDIT_WINDOW_MS = 5 * 60 * 1000;
const THREAD_QUIET_MS = 24 * 60 * 60 * 1000; // no messages for a day -> archived
const PING_COOLDOWN_MS = 60 * 1000; // per staff member per room
const PING_ESCALATE_MS = 3 * 60 * 1000; // unclaimed for this long -> waiting
const RECEIPT_WINDOW_MS = 30 * 60 * 1000;

// ── State ───────────────────────────────────────────────────────────────────
let desk = {
  seq: 0,
  channels: {}, // key -> [message]
  threads: [], // { id, title, createdBy, createdAt, lastTs, link, messages }
  lastRead: {}, // "role:label" -> { channelOrThreadId: ts }
  // Today's running tally, posted to #stats when the day turns over. Kept in
  // the saved file so a restart at teatime does not lose the morning.
  day: null,
};
for (const c of CHANNELS) desk.channels[c.key] = [];

const byId = new Map(); // message id -> { msg, key }
// Today's unique visitors. Declared up here because load() runs at require
// time and rebuilds it from the saved day.
let visitorSet = new Set();
let ctx = null; // wired once from rooms.js
let saveTimer = null;
let presenceTimer = null;
const sendTimes = new Map(); // idKey -> [ts] for rate limiting
const pingCooldowns = new Map(); // idKey|roomId -> ts
const pingEdge = new WeakMap(); // socket -> { mod, dev } token was present last text

function io() {
  return ctx && ctx.io();
}

// ── Identity ────────────────────────────────────────────────────────────────
function isStaff(socket) {
  return !!(socket && (socket.isDev || socket.isMod));
}

function who(socket) {
  // The avatar is the same validated Discord snowflake + hash the rooms use;
  // the client rebuilds the CDN URL itself and never trusts a raw URL.
  const av = socket.handshake?.session?.avatar;
  return {
    label: socket.staffLabel || (socket.isDev ? "dev" : "mod"),
    role: socket.isDev ? "dev" : "mod",
    level: socket.isDev ? 0 : socket.modLevel || 2,
    alias: socket.handshake?.session?.username || null,
    avatar:
      av && av.id && av.hash
        ? { id: String(av.id), hash: String(av.hash), animated: !!av.animated }
        : null,
  };
}

const idKeyOf = (w) => w.role + ":" + w.label;

function canRead(socket, key) {
  if (!isStaff(socket)) return false;
  if (key.startsWith("t")) return true; // threads are staff-wide
  const ch = CHANNELS.find((c) => c.key === key);
  if (!ch) return false;
  if (ch.access === "dev") return !!socket.isDev;
  if (ch.access === "l2") return socket.isDev || (socket.modLevel || 2) >= 2;
  return true;
}

const isReadonly = (key) => {
  const ch = CHANNELS.find((c) => c.key === key);
  return !!(ch && ch.readonly);
};

// A queue card keeps the audience it had on the notification feed, so the
// Desk can never show somebody a card the dashboard would have hidden.
function canSeeMessage(socket, key, msg) {
  if (!canRead(socket, key)) return false;
  if (msg.devOnly && !socket.isDev) return false;
  if (msg.minLevel && !socket.isDev && (socket.modLevel || 2) < msg.minLevel)
    return false;
  return true;
}

// ── Persistence (board.json pattern: debounce + tmp/rename + sync flush) ────
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = FILE + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(desk), "utf8");
      await fsp.rename(tmp, FILE);
    } catch (e) {
      console.error("staff chat save failed:", e.message);
    }
  }, 5000);
}

function flushSync() {
  try {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    fs.writeFileSync(FILE, JSON.stringify(desk), "utf8");
  } catch (e) {
    console.error("staff chat flush failed:", e.message);
  }
}

function indexAll() {
  byId.clear();
  for (const c of CHANNELS)
    for (const m of desk.channels[c.key] || []) byId.set(m.id, { msg: m, key: c.key });
  for (const t of desk.threads)
    for (const m of t.messages || []) byId.set(m.id, { msg: m, key: t.id });
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (raw && typeof raw === "object") {
      desk.seq = raw.seq || 0;
      desk.lastRead = raw.lastRead || {};
      desk.threads = Array.isArray(raw.threads) ? raw.threads : [];
      for (const c of CHANNELS)
        desk.channels[c.key] = Array.isArray(raw.channels?.[c.key])
          ? raw.channels[c.key]
          : [];
      if (raw.day && typeof raw.day === "object") {
        desk.day = raw.day;
        visitorSet = new Set(
          Array.isArray(raw.day.visitors) ? raw.day.visitors : [],
        );
      }
    }
  } catch (e) {
    if (e.code !== "ENOENT") console.error("staff chat load failed:", e.message);
  }
  indexAll();
}
load();

// ── Threads ─────────────────────────────────────────────────────────────────
// Archived is derived from quiet time, never a stored flag: threads that go a
// day without a message drop out of the sidebar but stay readable. Deleting
// staff discussion would erase the reasoning behind decisions, so only a dev
// can remove one, and it takes an explicit act.
const isArchived = (t) => Date.now() - (t.lastTs || t.createdAt) > THREAD_QUIET_MS;

function threadSummary(t) {
  return {
    id: t.id,
    title: t.title,
    createdBy: t.createdBy,
    createdAt: t.createdAt,
    lastTs: t.lastTs,
    archived: isArchived(t),
    link: t.link || null,
    n: (t.messages || []).length,
  };
}

function pruneArchived() {
  const archived = desk.threads.filter(isArchived);
  if (archived.length <= ARCHIVED_CAP) return;
  archived.sort((a, b) => (a.lastTs || 0) - (b.lastTs || 0));
  const drop = new Set(archived.slice(0, archived.length - ARCHIVED_CAP).map((t) => t.id));
  desk.threads = desk.threads.filter((t) => !drop.has(t.id));
}

// ── Mentions ────────────────────────────────────────────────────────────────
// A mention is "@" followed by a staff label, matched against the real list of
// labels rather than a word pattern: labels are free text and can carry spaces
// and punctuation, so anything-after-an-@ would guess wrong constantly. Longest
// label first, so "@Sam" never eats the mention of "@Sam T".
function staffLabels() {
  const out = new Set();
  try {
    for (const k of ctx.roles.listModKeys()) if (k.label) out.add(k.label);
    for (const d of ctx.roles.listDevKeys()) if (d.label) out.add(d.label);
  } catch (_) {}
  if (io())
    for (const [, s] of io().sockets.sockets)
      if (s.connected && isStaff(s) && s.staffLabel) out.add(s.staffLabel);
  return [...out].sort((a, b) => b.length - a.length);
}

function extractMentions(text) {
  if (typeof text !== "string" || text.indexOf("@") === -1) return [];
  const hit = [];
  const low = text.toLowerCase();
  for (const label of staffLabels()) {
    const needle = "@" + label.toLowerCase();
    let from = 0;
    for (;;) {
      const at = low.indexOf(needle, from);
      if (at === -1) break;
      from = at + needle.length;
      const before = at > 0 ? text[at - 1] : "";
      const after = text[from] || "";
      // Not part of a word, an email address, or a longer name.
      if (/[\w@#]/.test(before) || /\w/.test(after)) continue;
      if (!hit.includes(label)) hit.push(label);
      break;
    }
  }
  return hit;
}

// Was this socket's holder named? Messages written before mentions were stored
// fall back to the old substring test so old highlights do not disappear.
function mentions(msg, socket) {
  if (!socket.staffLabel) return false;
  const mine = socket.staffLabel.toLowerCase();
  if (Array.isArray(msg.mentions))
    return msg.mentions.some((l) => String(l).toLowerCase() === mine);
  return (
    typeof msg.text === "string" && msg.text.toLowerCase().includes("@" + mine)
  );
}

// ── Fan-out ─────────────────────────────────────────────────────────────────
// Messages go to every eligible STAFF socket whether the Desk is open or not,
// so the dock badge is always right. Volume is tiny: staff only.
function outbound(msg, socket) {
  const copy = { ...msg };
  // Edit and delete history is a dev-only view; a mod sees the tombstone.
  if (!socket.isDev) delete copy.history;
  copy.mention = mentions(msg, socket);
  return copy;
}

function broadcast(key, msg, updated) {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || !canSeeMessage(s, key, msg)) continue;
    s.emit("desk message", { key, msg: outbound(msg, s), updated: !!updated });
  }
}

function broadcastThreadList() {
  if (!io()) return;
  const list = desk.threads.map(threadSummary);
  for (const [, s] of io().sockets.sockets)
    if (s.connected && isStaff(s)) s.emit("desk threads", { threads: list });
}

// ── Messages ────────────────────────────────────────────────────────────────
function targetList(key) {
  if (key.startsWith("t")) {
    const t = desk.threads.find((x) => x.id === key);
    return t ? { list: t.messages, thread: t, cap: THREAD_MSG_CAP } : null;
  }
  return desk.channels[key] ? { list: desk.channels[key], cap: CHANNEL_CAP } : null;
}

function pushMessage(key, msg) {
  const tgt = targetList(key);
  if (!tgt) return null;
  msg.id = "m" + ++desk.seq;
  tgt.list.push(msg);
  byId.set(msg.id, { msg, key });
  if (tgt.list.length > tgt.cap) {
    const dropped = tgt.list.splice(0, tgt.list.length - tgt.cap);
    for (const d of dropped) byId.delete(d.id);
  }
  if (tgt.thread) {
    const wasArchived = isArchived(tgt.thread);
    tgt.thread.lastTs = msg.ts;
    if (wasArchived) broadcastThreadList(); // a reply revives it in the rail
  }
  scheduleSave();
  return msg;
}

function system(key, text, extra) {
  const msg = pushMessage(key, {
    ts: Date.now(),
    kind: "system",
    author: null,
    text: String(text || "").slice(0, 500),
    ...(extra || {}),
  });
  if (msg) broadcast(key, msg);
  return msg;
}

// Queue cards, fed from audit.recordNotification - the one place every
// report, appeal, application, suggestion and abuse flag already passes
// through. The card keeps the feed's audience level.
function systemQueues(qkind, text, opts) {
  if (qkind === "report") noteEvent("report");
  return system("queues", text, {
    qkind: qkind || "notice",
    minLevel: (opts && opts.minLevel) || null,
    devOnly: !!(opts && opts.devOnly),
  });
}

// ── The daily tally ─────────────────────────────────────────────────────────
// Counted here rather than mined out of the audit log, because most of it
// (visitors, rooms opened, how many were on at once) is never written down
// anywhere. The day boundary is the same Pacific one the dashboard groups its
// activity feed by, so "yesterday" means the same thing in both places.
const VISITOR_CAP = 5000;

function freshDay(start) {
  return {
    start,
    visitors: [],
    rooms: 0,
    reports: 0,
    pings: 0,
    actions: 0,
    peak: 0,
    boardStrokes: 0,
  };
}

function dayStart(now) {
  try {
    const s = ctx && ctx.audit && ctx.audit.startOfPacificDay(now);
    if (s) return s;
  } catch (_) { }
  // No Intl on this build: fall back to UTC midnight rather than never rolling.
  return Math.floor(now / 86400000) * 86400000;
}

function ensureDay(now) {
  const start = dayStart(now || Date.now());
  if (!desk.day) {
    desk.day = freshDay(start);
    visitorSet = new Set();
    return;
  }
  if (desk.day.start === start) return;
  const finished = desk.day;
  desk.day = freshDay(start);
  visitorSet = new Set();
  postDailyStats(finished);
}

function noteEvent(kind, id) {
  ensureDay();
  const d = desk.day;
  if (kind === "visitor") {
    if (!id || visitorSet.has(id)) return;
    visitorSet.add(id);
    if (d.visitors.length < VISITOR_CAP) d.visitors.push(id);
    scheduleSave();
    return;
  }
  if (kind === "room") d.rooms++;
  else if (kind === "report") d.reports++;
  else if (kind === "ping") d.pings++;
  else if (kind === "action") d.actions++;
  else if (kind === "stroke") d.boardStrokes++;
  else return;
  scheduleSave();
}

const plural = (n, one, many) => n + " " + (n === 1 ? one : many || one + "s");

function postDailyStats(d) {
  if (!d) return;
  const visitors = visitorSet.size || d.visitors.length;
  // A day where literally nothing happened is not worth a post.
  if (!visitors && !d.rooms && !d.actions) return;
  const when = new Date(d.start).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const bits = [
    plural(visitors, "person", "people") + " stopped by",
    plural(d.rooms, "room") + " opened",
  ];
  if (d.peak) bits.push(d.peak + " online at once at the busiest");
  if (d.actions) bits.push(plural(d.actions, "staff action"));
  if (d.reports) bits.push(plural(d.reports, "report"));
  if (d.pings) bits.push(plural(d.pings, "call") + " for backup");
  const msg = pushMessage("stats", {
    ts: Date.now(),
    kind: "system",
    author: null,
    qkind: "stats",
    text: when + ": " + bits.join(", ") + ".",
  });
  if (msg) broadcast("stats", msg);
}

function samplePeak() {
  if (!io()) return;
  ensureDay();
  let n = 0;
  for (const [, s] of io().sockets.sockets)
    if (s.connected && !s.isModLog && s.handshake?.session?.userId) n++;
  if (n > desk.day.peak) {
    desk.day.peak = n;
    scheduleSave();
  }
}

// ── Rate limiting ───────────────────────────────────────────────────────────
// A leaked staff key that can spam every moderator's phone is a denial of
// service on the team itself, so sends are throttled per identity.
function allowSend(idKey) {
  const now = Date.now();
  const times = (sendTimes.get(idKey) || []).filter((t) => now - t < 10000);
  if (times.length >= 8) return false;
  times.push(now);
  sendTimes.set(idKey, times);
  return true;
}

// ── Unread ──────────────────────────────────────────────────────────────────
function unreadFor(socket) {
  const w = who(socket);
  const read = desk.lastRead[idKeyOf(w)] || {};
  const out = {};
  for (const c of CHANNELS) {
    if (!canRead(socket, c.key)) continue;
    const since = read[c.key] || 0;
    let n = 0;
    let named = 0;
    for (let i = desk.channels[c.key].length - 1; i >= 0; i--) {
      const m = desk.channels[c.key][i];
      if (m.ts <= since) break;
      if (!canSeeMessage(socket, c.key, m)) continue;
      n++;
      if (mentions(m, socket)) named++;
    }
    out[c.key] = { n, mentions: named };
  }
  for (const t of desk.threads) {
    const since = read[t.id] || 0;
    let n = 0;
    for (let i = t.messages.length - 1; i >= 0; i--) {
      if (t.messages[i].ts <= since) break;
      n++;
    }
    if (n) out[t.id] = { n, mentions: 0 };
  }
  return out;
}

// ── The team ────────────────────────────────────────────────────────────────
// Everyone holding a key, on or off. It backs both the team view and the "@"
// list, so it has to be right the moment a key is granted or pulled - hence
// rosterDirty, which pushes it rather than waiting to be asked.
function rosterFor(socket) {
  const live = buildPresence(socket).staff;
  const online = new Map(live.map((s) => [s.role + ":" + s.label, s]));

  // Last time each staff label did anything, from the action log.
  const lastBy = new Map();
  try {
    for (const s of ctx.audit.leaderboard())
      lastBy.set((s.role || "mod") + ":" + s.label, s.last || null);
  } catch (_) {}

  const out = [...live];
  try {
    for (const k of ctx.roles.listModKeys()) {
      const key = "mod:" + k.label;
      if (online.has(key)) continue;
      out.push({
        label: k.label,
        role: "mod",
        level: k.level || 2,
        offline: true,
        lastActive: lastBy.get(key) || null,
        grantedAt: k.grantedAt || null,
        locations: [],
      });
    }
    for (const d of ctx.roles.listDevKeys()) {
      const key = "dev:" + d.label;
      if (online.has(key)) continue;
      out.push({
        label: d.label,
        role: "dev",
        level: 0,
        offline: true,
        lastActive: lastBy.get(key) || null,
        locations: [],
      });
    }
  } catch (_) {}
  return out;
}

// Somebody was granted a key, promoted, or removed: everybody's team list and
// "@" list is now wrong until they are told.
function rosterDirty() {
  if (!io()) return;
  for (const [, s] of io().sockets.sockets)
    if (s.connected && s.deskHello && isStaff(s))
      s.emit("desk roster", { staff: rosterFor(s) });
}

// ── Presence ────────────────────────────────────────────────────────────────
// Who is on, and where. Hidden staff appear to everyone marked hidden: a mod
// who is invisible in a room AND unidentifiable here would be unaccountable in
// both directions. Vanished devs stay dev-only, matching everywhere else.
function buildPresence(recipient) {
  const staff = new Map(); // idKey -> row
  const roomsWithStaff = new Map(); // roomId -> Set(label)
  if (!io()) return { staff: [], rooms: [] };

  for (const [, s] of io().sockets.sockets) {
    if (!s.connected || !isStaff(s)) continue;
    if (s.isVanished && !recipient.isDev) continue;
    const w = who(s);
    const k = idKeyOf(w);
    let row = staff.get(k);
    if (!row) {
      row = {
        label: w.label,
        role: w.role,
        level: w.level,
        alias: w.alias,
        avatar: w.avatar,
        hidden: false,
        vanished: false,
        locations: [],
      };
      staff.set(k, row);
    }
    if (!row.alias && w.alias) row.alias = w.alias;
    if (!row.avatar && w.avatar) row.avatar = w.avatar;
    if (s.isHidden) row.hidden = true;
    if (s.isVanished) row.vanished = true;
    const room = s.roomId ? ctx.state.rooms.get(s.roomId) : null;
    let loc = null;
    if (room && s.spectating)
      loc = { kind: "watch", roomId: room.id, roomName: room.name };
    else if (room) loc = { kind: "room", roomId: room.id, roomName: room.name };
    else if (s.isModLog) loc = { kind: "dashboard" };
    else if (s.handshake?.auth?.app === "desk") loc = { kind: "desk" };
    else loc = { kind: "lobby" };
    if (
      !row.locations.some(
        (l) => l.kind === loc.kind && l.roomId === loc.roomId,
      )
    )
      row.locations.push(loc);
    if (room && !s.spectating) {
      if (!roomsWithStaff.has(room.id)) roomsWithStaff.set(room.id, new Set());
      roomsWithStaff.get(room.id).add(w.label);
    }
  }

  const rooms = [];
  for (const [id, room] of ctx.state.rooms) {
    const users = room.users || [];
    const visible = recipient.isDev
      ? users.length
      : users.filter((u) => !u.isVanished).length;
    rooms.push({
      id,
      name: room.name,
      type: room.type,
      n: visible,
      locked: !!room.locked,
      slow: !!room.slowMode,
      staff: [...(roomsWithStaff.get(id) || [])],
    });
  }
  rooms.sort((a, b) => b.n - a.n);

  return {
    staff: [...staff.values()].sort((a, b) => a.label.localeCompare(b.label)),
    rooms,
  };
}

function presenceDirty() {
  if (presenceTimer || !io()) return;
  presenceTimer = setTimeout(() => {
    presenceTimer = null;
    for (const [, s] of io().sockets.sockets)
      if (s.connected && isStaff(s) && s.deskHello)
        s.emit("desk presence", buildPresence(s));
  }, 400);
}

// ── Pings ───────────────────────────────────────────────────────────────────
// A staff member types @mod or @dev in their room textbox. The textbox is live
// character by character, so the trigger is edge-based: it fires when the
// token APPEARS in the text, never again while it stays there, and a cooldown
// stops a retype from stacking cards.
function onRoomText(socket, roomId, text) {
  if (!ctx || !isStaff(socket) || !roomId) return;
  const had = pingEdge.get(socket) || { mod: false, dev: false };
  const has = {
    mod: /(^|\s)@mods?\b/i.test(text),
    dev: /(^|\s)@devs?\b/i.test(text),
  };
  pingEdge.set(socket, has);
  const wants = has.dev && !had.dev ? "dev" : has.mod && !had.mod ? "mod" : null;
  if (!wants) return;

  const w = who(socket);
  const cdKey = idKeyOf(w) + "|" + roomId;
  const now = Date.now();
  if (now - (pingCooldowns.get(cdKey) || 0) < PING_COOLDOWN_MS) return;
  pingCooldowns.set(cdKey, now);
  if (pingCooldowns.size > 500)
    for (const [k, t] of pingCooldowns)
      if (now - t > PING_COOLDOWN_MS) pingCooldowns.delete(k);

  const room = ctx.state.rooms.get(roomId);
  if (!room) return;
  const users = room.users || [];
  const staffThere = users
    .filter((u) => u.isDev || u.isMod)
    .map((u) => u.username);

  noteEvent("ping");
  const msg = pushMessage("help", {
    ts: now,
    kind: "ping",
    author: w,
    text: "@" + wants + " needed in " + (room.name || "a room"),
    ping: {
      wants,
      roomId,
      roomName: room.name || "?",
      byLabel: w.label,
      byUserId: socket.handshake?.session?.userId || null,
      status: "open",
      count: users.length,
      staffThere,
      claimedBy: null,
      claimedAt: null,
      resolvedBy: null,
      resolvedAt: null,
      note: null,
      actions: [],
    },
  });
  if (!msg) return;
  broadcast("help", msg);

  // Nobody claims it in time: the card goes loud rather than sliding away.
  setTimeout(() => {
    const ref = byId.get(msg.id);
    if (!ref || ref.msg.ping?.status !== "open") return;
    ref.msg.ping.status = "waiting";
    scheduleSave();
    broadcast("help", ref.msg, true);
  }, PING_ESCALATE_MS);
}

// A staff action lands while a ping for that room is live: attach a receipt,
// so the card ends up a record of what was actually done about it. Called
// from logStaff; must stay cheap because logStaff fires on everything.
function noteStaffAction(byLabel, action, targetStr, roomTag) {
  if (!roomTag || typeof roomTag !== "string") return;
  const open = roomTag.lastIndexOf("(");
  const close = roomTag.lastIndexOf(")");
  if (open === -1 || close < open) return;
  const roomId = roomTag.slice(open + 1, close);
  if (/^(spectate|staff key)/.test(action)) return;
  const now = Date.now();
  let touched = false;
  const list = desk.channels.help;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (now - m.ts > RECEIPT_WINDOW_MS) break;
    const p = m.ping;
    if (!p || p.roomId !== roomId) continue;
    if (p.status === "resolved") continue;
    let target = null;
    if (targetStr && targetStr.startsWith("user:")) {
      const o = targetStr.lastIndexOf("(");
      target = o > 5 ? targetStr.slice(5, o) : targetStr.slice(5);
    }
    p.actions.push({ ts: now, by: byLabel, action, target });
    if (p.actions.length > 20) p.actions.shift();
    broadcast("help", m, true);
    touched = true;
  }
  if (touched) scheduleSave();
}

// ── Socket wiring ───────────────────────────────────────────────────────────
function init(context) {
  ctx = context;
  // A safety-net refresh so presence never sits stale for long even if a hook
  // was missed somewhere.
  setInterval(presenceDirty, 25000).unref();
  // Watches the clock for the day rolling over, and keeps the busiest-moment
  // number honest between rollovers.
  ensureDay();
  setInterval(() => {
    ensureDay();
    samplePeak();
  }, 60000).unref();
}

function register(socket, safe) {
  // Everything re-checks isStaff on every event: a revoked key is already
  // live-downgraded on its sockets, and that must cut Desk access instantly.

  socket.on(
    "desk hello",
    safe(async () => {
      if (!isStaff(socket)) return; // non-staff never even get an error
      socket.deskHello = true;
      const w = who(socket);
      socket.emit("desk ready", {
        me: w,
        channels: CHANNELS.filter((c) => canRead(socket, c.key)).map((c) => ({
          key: c.key,
          name: c.name,
          desc: c.desc,
          restricted: !!c.access,
          readonly: !!c.readonly,
        })),
        threads: desk.threads.map(threadSummary),
        unread: unreadFor(socket),
        presence: buildPresence(socket),
      });
    }),
  );

  socket.on(
    "desk history",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const key = typeof data?.key === "string" ? data.key : "";
      if (!canRead(socket, key)) return;
      const tgt = targetList(key);
      if (!tgt) return;
      const thread = key.startsWith("t")
        ? threadSummary(desk.threads.find((t) => t.id === key) || {})
        : null;

      // Jumping to a search hit: a window centred on that moment, with room
      // to page in both directions.
      const around = Number(data?.around) || 0;
      if (around) {
        const visible = tgt.list.filter((m) => canSeeMessage(socket, key, m));
        let at = visible.findIndex((m) => m.ts >= around);
        if (at === -1) at = visible.length - 1;
        const start = Math.max(0, at - 24);
        const end = Math.min(visible.length, at + 26);
        return socket.emit("desk history", {
          key,
          around,
          messages: visible.slice(start, end).map((m) => outbound(m, socket)),
          hasMore: start > 0,
          hasMoreNewer: end < visible.length,
          thread,
        });
      }

      const before = Number(data?.before) || Infinity;
      const visible = tgt.list.filter(
        (m) => m.ts < before && canSeeMessage(socket, key, m),
      );
      const page = visible.slice(-50);
      socket.emit("desk history", {
        key,
        before: Number.isFinite(before) ? before : null,
        messages: page.map((m) => outbound(m, socket)),
        hasMore: visible.length > page.length,
        thread,
      });
    }),
  );

  socket.on(
    "desk send",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const key = typeof data?.key === "string" ? data.key : "";
      if (!canRead(socket, key))
        return socket.emit("desk error", { message: "You cannot post there." });
      if (isReadonly(key))
        return socket.emit("desk error", {
          message: "#" + key + " is written by the server. Try #floor.",
        });
      const w = who(socket);
      if (!allowSend(idKeyOf(w)))
        return socket.emit("desk error", {
          message: "Slow down - a few seconds between messages.",
        });
      const text = String(data?.text || "").trim().slice(0, MSG_MAX);
      if (!text) return;
      // Replies carry a snapshot of what they answer, not just an id, so the
      // quote still reads after the original is pruned or edited.
      let reply = null;
      if (typeof data?.replyTo === "string") {
        const ref = byId.get(data.replyTo);
        if (ref && ref.key === key && !ref.msg.deletedAt)
          reply = {
            id: ref.msg.id,
            ts: ref.msg.ts,
            label: ref.msg.author ? ref.msg.author.label : "system",
            text: String(ref.msg.text || "").slice(0, 120),
          };
      }
      // Who was named, worked out once here rather than by every reader.
      const named = extractMentions(text);
      const msg = pushMessage(key, {
        ts: Date.now(),
        kind: "chat",
        author: w,
        text,
        ...(named.length ? { mentions: named } : {}),
        ...(reply ? { reply } : {}),
      });
      if (!msg) return;
      broadcast(key, msg);
      if (!named.length) return;

      // Naming somebody is a ping. Whoever is on gets it now; whoever is off
      // is not lost - it counts as an unread mention and is waiting for them
      // the moment they sign back in. The sender is told which is which so
      // they know whether to expect an answer.
      const on = new Set();
      const mine = idKeyOf(w);
      for (const [, s] of io().sockets.sockets) {
        if (!s.connected || !isStaff(s) || !s.staffLabel) continue;
        const label = named.find(
          (l) => l.toLowerCase() === s.staffLabel.toLowerCase(),
        );
        if (!label) continue;
        on.add(label);
        if (idKeyOf(who(s)) === mine) continue; // naming yourself pings nobody
        if (!canSeeMessage(s, key, msg)) continue;
        s.emit("desk mention", { key, id: msg.id, by: w.label });
      }
      socket.emit("desk mention receipt", {
        key,
        id: msg.id,
        pinged: named,
        offline: named.filter(
          (l) => !on.has(l) && l.toLowerCase() !== w.label.toLowerCase(),
        ),
      });
    }),
  );

  // Turns a name or user id into someone the staff events can act on. This
  // is what lets a command like /kick take a username: the client asks here,
  // then fires the same staff event a button would have.
  socket.on(
    "desk resolve",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const q = String(data?.q || "").trim();
      if (!q || q.length > 60) return;
      const ql = q.toLowerCase();
      const seen = new Map(); // userId -> candidate
      const consider = (id, username, roomId, exact) => {
        if (!id || seen.has(id)) return;
        const room = roomId ? ctx.state.rooms.get(roomId) : null;
        seen.set(id, {
          id,
          username: username || "?",
          roomId: room ? room.id : null,
          roomName: room ? room.name : null,
          exact,
        });
      };
      for (const [, s] of io().sockets.sockets) {
        if (!s.connected) continue;
        const id = s.handshake?.session?.userId;
        const name = s.handshake?.session?.username || "";
        if (!id) continue;
        if (id === q) consider(id, name, s.roomId, true);
        else if (name.toLowerCase() === ql) consider(id, name, s.roomId, true);
        else if (name.toLowerCase().startsWith(ql))
          consider(id, name, s.roomId, false);
      }
      const matches = [...seen.values()]
        .sort((a, b) => (b.exact ? 1 : 0) - (a.exact ? 1 : 0))
        .slice(0, 5);
      socket.emit("desk resolve", {
        q,
        matches: matches.map(({ exact, ...m }) => m),
        exact: matches.filter((m) => m.exact).length,
      });
    }),
  );

  socket.on(
    "desk edit",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const ref = byId.get(String(data?.id || ""));
      if (!ref || ref.msg.kind !== "chat" || ref.msg.deletedAt) return;
      const w = who(socket);
      if (!ref.msg.author || idKeyOf(ref.msg.author) !== idKeyOf(w))
        return socket.emit("desk error", { message: "Not your message." });
      if (Date.now() - ref.msg.ts > EDIT_WINDOW_MS)
        return socket.emit("desk error", {
          message: "Edits close five minutes after sending.",
        });
      const text = String(data?.text || "").trim().slice(0, MSG_MAX);
      if (!text) return;
      // Devs can always read what a message said before it changed.
      (ref.msg.history = ref.msg.history || []).push({
        ts: Date.now(),
        text: ref.msg.text,
      });
      ref.msg.text = text;
      ref.msg.editedAt = Date.now();
      // An edit can add or drop a name. It re-marks the message, but it never
      // re-pings: an edit is not a way to poke somebody twice.
      const named = extractMentions(text);
      if (named.length) ref.msg.mentions = named;
      else delete ref.msg.mentions;
      scheduleSave();
      broadcast(ref.key, ref.msg, true);
    }),
  );

  socket.on(
    "desk delete",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const ref = byId.get(String(data?.id || ""));
      if (!ref || ref.msg.deletedAt) return;
      const w = who(socket);
      const own = ref.msg.author && idKeyOf(ref.msg.author) === idKeyOf(w);
      if (!own && !socket.isDev)
        return socket.emit("desk error", { message: "Not your message." });
      // A tombstone, never a silent hole: everyone can see something was
      // removed and by whom, and devs keep the original text.
      (ref.msg.history = ref.msg.history || []).push({
        ts: Date.now(),
        text: ref.msg.text,
      });
      ref.msg.text = "";
      ref.msg.deletedAt = Date.now();
      ref.msg.deletedBy = w.label;
      scheduleSave();
      broadcast(ref.key, ref.msg, true);
    }),
  );

  socket.on(
    "desk thread create",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const title = String(data?.title || "").trim().slice(0, 60);
      if (!title) return;
      const w = who(socket);
      const t = {
        id: "t" + ++desk.seq,
        title,
        createdBy: w.label,
        createdAt: Date.now(),
        lastTs: Date.now(),
        link:
          data?.link && typeof data.link.roomId === "string"
            ? {
                roomId: String(data.link.roomId).slice(0, 12),
                roomName: String(data.link.roomName || "").slice(0, 60),
              }
            : null,
        messages: [],
      };
      desk.threads.push(t);
      pruneArchived();
      scheduleSave();
      broadcastThreadList();
      socket.emit("desk thread created", { id: t.id });
    }),
  );

  socket.on(
    "desk thread delete",
    safe(async (data) => {
      if (!socket.isDev) return; // deleting discussion is a dev-only act
      const id = String(data?.id || "");
      const t = desk.threads.find((x) => x.id === id);
      if (!t) return;
      for (const m of t.messages) byId.delete(m.id);
      desk.threads = desk.threads.filter((x) => x.id !== id);
      scheduleSave();
      broadcastThreadList();
    }),
  );

  socket.on(
    "desk read",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const key = typeof data?.key === "string" ? data.key : "";
      if (!canRead(socket, key)) return;
      const w = who(socket);
      const k = idKeyOf(w);
      if (!desk.lastRead[k]) desk.lastRead[k] = {};
      desk.lastRead[k][key] = Math.max(
        desk.lastRead[k][key] || 0,
        Number(data?.ts) || Date.now(),
      );
      scheduleSave();
      // Every tab this person has open agrees about what is read. Matching by
      // identity label rather than session covers the dashboard socket too.
      let synced = false;
      if (io())
        for (const [, s] of io().sockets.sockets) {
          if (!s.connected || !isStaff(s) || !s.deskHello) continue;
          if (idKeyOf(who(s)) !== k) continue;
          s.emit("desk unread", { unread: unreadFor(s) });
          if (s === socket) synced = true;
        }
      if (!synced) socket.emit("desk unread", { unread: unreadFor(socket) });
    }),
  );

  socket.on(
    "desk presence",
    safe(async () => {
      if (!isStaff(socket)) return;
      socket.emit("desk presence", buildPresence(socket));
    }),
  );

  // The whole team, not just whoever is on. Offline members carry when they
  // were last doing something, which is the thing you actually want to know
  // before deciding whether to wait for them or handle it yourself.
  socket.on(
    "desk roster",
    safe(async () => {
      if (!isStaff(socket)) return;
      socket.emit("desk roster", { staff: rosterFor(socket) });
    }),
  );

  socket.on(
    "desk ping claim",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const ref = byId.get(String(data?.id || ""));
      const p = ref?.msg?.ping;
      if (!p || (p.status !== "open" && p.status !== "waiting")) return;
      const w = who(socket);
      p.status = "claimed";
      p.claimedBy = w.label;
      p.claimedAt = Date.now();
      scheduleSave();
      broadcast(ref.key, ref.msg, true);
      // The person who asked sees, in their room, that help is coming - this
      // is what stops three mods piling into the same guest.
      if (p.byUserId)
        for (const s of ctx.findSocketsByUserId(p.byUserId))
          if (isStaff(s))
            s.emit("desk ping update", {
              id: ref.msg.id,
              status: "claimed",
              by: w.label,
            });
    }),
  );

  socket.on(
    "desk ping resolve",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const ref = byId.get(String(data?.id || ""));
      const p = ref?.msg?.ping;
      if (!p || p.status === "resolved") return;
      const w = who(socket);
      // The claimer closes their own card; a dev can close any; an unclaimed
      // card can be closed by whoever handled it.
      if (p.status === "claimed" && p.claimedBy !== w.label && !socket.isDev)
        return socket.emit("desk error", {
          message: p.claimedBy + " claimed this one.",
        });
      p.status = "resolved";
      p.resolvedBy = w.label;
      p.resolvedAt = Date.now();
      p.note = String(data?.note || "").trim().slice(0, 200) || null;
      scheduleSave();
      broadcast(ref.key, ref.msg, true);
    }),
  );

  // The room inspector: see into a room and act without joining it. All staff
  // levels get the view (a junior trusted to kick can see what they are
  // kicking for); the actions themselves stay behind their existing per-level
  // server gates, so this widens sight, never power.
  socket.on(
    "desk room info",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const roomId = typeof data?.roomId === "string" ? data.roomId : "";
      const room = ctx.state.rooms.get(roomId);
      if (!room)
        return socket.emit("desk room info", { roomId, gone: true });
      const users = (room.users || [])
        .filter((u) => socket.isDev || !u.isVanished)
        .map((u) => ({
          ...ctx.formatUserForSocket(u, socket),
          location: u.location || "",
        }));
      socket.emit("desk room info", {
        roomId,
        name: room.name,
        type: room.type,
        locked: !!room.locked,
        slow: !!room.slowMode,
        users,
      });
    }),
  );

  socket.on(
    "desk search",
    safe(async (data) => {
      if (!isStaff(socket)) return;
      const q = String(data?.q || "").trim().toLowerCase();
      if (q.length < 2 || q.length > 80) return;
      const hits = [];
      const scan = (key, list, title) => {
        for (let i = list.length - 1; i >= 0 && hits.length < 60; i--) {
          const m = list[i];
          if (m.deletedAt || !m.text) continue;
          if (!canSeeMessage(socket, key, m)) continue;
          if (
            m.text.toLowerCase().includes(q) ||
            (m.author && m.author.label.toLowerCase().includes(q))
          )
            hits.push({
              key,
              title: title || null,
              ts: m.ts,
              author: m.author ? m.author.label : null,
              text: m.text.slice(0, 200),
            });
        }
      };
      for (const c of CHANNELS)
        if (canRead(socket, c.key)) scan(c.key, desk.channels[c.key]);
      for (const t of desk.threads) scan(t.id, t.messages, t.title);
      hits.sort((a, b) => b.ts - a.ts);
      socket.emit("desk search", { q, hits: hits.slice(0, 60) });
    }),
  );
}

module.exports = {
  init,
  register,
  onRoomText,
  noteStaffAction,
  systemQueues,
  noteEvent,
  presenceDirty,
  rosterDirty,
  flushSync,
};
