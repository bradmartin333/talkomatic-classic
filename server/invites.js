// server/invites.js
// Invite tracking + leaderboard credit, hardened against pending-farming.
// A referral has three states:
//   touched - ref link opened; counts for nothing (all a drive-by bot can do).
//   pending - invitee became a real visitor (custom name + PENDING_MIN_SEC + a
//             tick, non-shared IP, under the per-IP cap); shows on the board.
//   active  - invitee became an active member (see identity.js), non-shared IP;
//             earns trophies and milestones. Expensive to fake at scale.
// Pending that never goes active expires (PENDING_TTL); staff can also remove a
// flagged cluster by hand (soft-delete, reversible) via report/purgeCohort/
// undoPurge. MILESTONE_MOD active invites only auto-file a reviewed application -
// power is never granted automatically.
// Persisted to invites.json (atomic, debounced); load() migrates old records
// forward so the board survives restarts and version updates.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;
const crypto = require("crypto");

const { DATA_DIR } = require("./datadir");

const INV_PATH = path.join(DATA_DIR, "invites.json");
const MAX_DEVICES = 50000;
const MAX_IPS = 8;
const MILESTONE_MOD = 10; // active invites → auto-files a mod application
const MILESTONE_DEV = 100; // a visible stretch goal (never grants anything)

// ── Anti-fraud knobs (all tunable here) ─────────────────────────────────────
const PENDING_MIN_SEC = 60; // invitee presence (seconds) to earn a pending
const PENDING_MIN_ACTS = 1; // invitee participation ticks to earn a pending
const PENDING_PER_IP = 2; // max pending+active one inviter may hold per IP
const TOUCHED_TTL = 3 * 24 * 60 * 60 * 1000; // forget a never-earned touch
const PENDING_TTL = 7 * 24 * 60 * 60 * 1000; // pending expires if never active
const REMOVED_TTL = 30 * 24 * 60 * 60 * 1000; // keep soft-deleted for dev undo
const COHORT_MIN = 3; // min invites for a same-IP cluster to be purgeable

// { codes: { code: deviceId }, devices: { deviceId: {
//     code, referrer, invited:{ inviteeId:{ at, ip, state, pendingAt, activeAt,
//       removed, removedBy, removedAt, reason, batch } }, ips:[], lastSeen } } }
let store = { codes: {}, devices: {} };
let saveTimer = null;
let topThree = []; // deviceIds of the top inviters, for the lobby/room trophies

// True for an auto-generated guest handle (the lobby "Guest#####", the IP-based
// "Guest-HASH" fallback, or a placeholder) - i.e. NOT a real chosen username.
function isGuestName(name) {
  if (!name) return true;
  const n = String(name).trim();
  if (!n) return true;
  if (/^Guest\d+$/i.test(n)) return true;
  if (/^Guest-[0-9a-f]+$/i.test(n)) return true;
  if (/^(Anonymous|Someone|Unknown)$/i.test(n)) return true;
  return false;
}

// Count a device's invites by state, ignoring soft-deleted ones. The board,
// trophies, rank, and stats all derive from this, so removals and expiry are
// reflected everywhere at once.
function tally(d) {
  let active = 0;
  let pending = 0;
  const inv = (d && d.invited) || {};
  for (const k in inv) {
    const r = inv[k];
    if (!r || r.removed) continue;
    if (r.state === "active") active++;
    else if (r.state === "pending") pending++;
  }
  return { active, pending, total: active + pending };
}

// Top 3 inviters for the username trophy badges. Requires >= 1 ACTIVE invite, so
// a trophy can't be won on pending alone; same ordering as leaderboard().
function recomputeTop() {
  topThree = Object.entries(store.devices)
    .map(([id, d]) => {
      const t = tally(d);
      return { id, active: t.active, pending: t.pending, total: t.total };
    })
    .filter((x) => x.active > 0)
    .sort(
      (a, b) => b.active - a.active || b.pending - a.pending || b.total - a.total,
    )
    .slice(0, 3)
    .map((x) => x.id);
}

// 1, 2, or 3 if this device is a top inviter, else 0 (for the trophy badge).
function rankBadge(deviceId) {
  if (!deviceId) return 0;
  const i = topThree.indexOf(deviceId);
  return i >= 0 ? i + 1 : 0;
}

// Forward-migrate old records (which had only a `credited` boolean): credited →
// active, otherwise → pending dated from the original invite. Keeps the board
// intact across the upgrade while letting expiry/purge clean it.
function migrate() {
  for (const id in store.devices) {
    const d = store.devices[id];
    if (!d.invited) d.invited = {};
    for (const k in d.invited) {
      const r = d.invited[k];
      if (!r || r.state) continue;
      if (r.credited) {
        r.state = "active";
        r.activeAt = r.at || Date.now();
      } else {
        r.state = "pending";
        r.pendingAt = r.at || Date.now();
      }
      delete r.credited;
    }
  }
}

function load() {
  try {
    const o = JSON.parse(fs.readFileSync(INV_PATH, "utf8"));
    if (o && typeof o === "object") store = o;
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading invites.json:", err);
  }
  if (!store.codes) store.codes = {};
  if (!store.devices) store.devices = {};
  migrate();
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      prune();
      const tmp = INV_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(store), "utf8");
      await fsp.rename(tmp, INV_PATH);
    } catch (e) {
      console.error("invites save failed:", e);
    }
  }, 4000);
}

function genCode(deviceId) {
  const base = crypto
    .createHash("sha256")
    .update("inv:" + deviceId)
    .digest("hex")
    .slice(0, 8);
  let code = base;
  let i = 0;
  while (store.codes[code] && store.codes[code] !== deviceId)
    code = base + (++i).toString(36);
  return code;
}

function ensureDevice(deviceId) {
  if (!deviceId) return null;
  let d = store.devices[deviceId];
  if (!d) {
    const code = genCode(deviceId);
    d = store.devices[deviceId] = {
      code,
      referrer: null,
      invited: {},
      ips: [],
      lastSeen: Date.now(),
    };
    store.codes[code] = deviceId;
    saveSoon();
  }
  return d;
}

function codeFor(deviceId) {
  const d = ensureDevice(deviceId);
  return d ? d.code : null;
}

function recordIp(deviceId, ip) {
  const d = ensureDevice(deviceId);
  if (!d) return;
  d.lastSeen = Date.now();
  if (ip && !d.ips.includes(ip)) {
    d.ips.push(ip);
    if (d.ips.length > MAX_IPS) d.ips = d.ips.slice(-MAX_IPS);
  }
  saveSoon();
}

// Record who referred this device - once only, never yourself. This only marks
// the referral "touched"; it counts for nothing until the invitee earns a
// pending (promoteIfEarned), so a drive-by socket cannot move the board.
function setReferrer(inviteeDeviceId, code, inviteeIp) {
  if (!inviteeDeviceId || !code) return { ok: false };
  const inviterDeviceId = store.codes[code];
  if (!inviterDeviceId || inviterDeviceId === inviteeDeviceId)
    return { ok: false };
  const invitee = ensureDevice(inviteeDeviceId);
  if (invitee.referrer) return { ok: false, already: true };
  const inviter = ensureDevice(inviterDeviceId);
  invitee.referrer = inviterDeviceId;
  inviter.invited[inviteeDeviceId] = {
    at: Date.now(),
    ip: inviteeIp || null,
    state: "touched",
  };
  saveSoon();
  return { ok: true };
}

function sharesIp(a, b) {
  return !!(a && b && a.ips && b.ips && a.ips.some((ip) => b.ips.includes(ip)));
}

// How many pending+active this inviter already holds from a given IP.
function ipHoldCount(inviter, ip) {
  if (!ip) return 0;
  let n = 0;
  const inv = inviter.invited || {};
  for (const k in inv) {
    const r = inv[k];
    if (!r || r.removed) continue;
    if ((r.state === "pending" || r.state === "active") && r.ip === ip) n++;
  }
  return n;
}

// Did this invitee clear the "real visitor" bar? A custom username (not a guest
// handle), some real presence, and at least one participation tick.
function earnedPending(idFields) {
  if (!idFields) return false;
  if (isGuestName(idFields.name)) return false;
  if ((idFields.sec || 0) < PENDING_MIN_SEC) return false;
  if ((idFields.acts || 0) < PENDING_MIN_ACTS) return false;
  return true;
}

// Promote this invitee's referral from touched → pending once they have become
// a real visitor (earnedPending), are not sharing the inviter's IP, and the
// inviter is under the per-IP cap. idFields = { name, sec, acts } for the
// invitee, supplied by the caller so this module needs no identity.js import.
// Returns { inviterDeviceId } on a change, else null.
function promoteIfEarned(inviteeDeviceId, idFields) {
  const invitee = store.devices[inviteeDeviceId];
  if (!invitee || !invitee.referrer) return null;
  const inviter = store.devices[invitee.referrer];
  if (!inviter) return null;
  const rec = inviter.invited && inviter.invited[inviteeDeviceId];
  if (!rec || rec.removed || rec.state !== "touched") return null;
  if (!earnedPending(idFields)) return null;
  if (sharesIp(invitee, inviter)) return null;
  if (ipHoldCount(inviter, rec.ip) >= PENDING_PER_IP) return null;
  rec.state = "pending";
  rec.pendingAt = Date.now();
  recomputeTop();
  saveSoon();
  return { inviterDeviceId: invitee.referrer };
}

// Credit the inviter when this invitee has become active and isn't sharing an
// IP with the inviter. Promotes touched/pending → active. Returns
// { credited, inviterDeviceId, newCount } or null.
function creditIfEligible(inviteeDeviceId, isActiveFn) {
  const invitee = store.devices[inviteeDeviceId];
  if (!invitee || !invitee.referrer) return null;
  const inviter = store.devices[invitee.referrer];
  if (!inviter) return null;
  const rec = inviter.invited && inviter.invited[inviteeDeviceId];
  if (!rec || rec.removed || rec.state === "active") return null;
  if (typeof isActiveFn === "function" && !isActiveFn(inviteeDeviceId))
    return null;
  if (sharesIp(invitee, inviter)) return null; // same network → don't count
  rec.state = "active";
  rec.activeAt = Date.now();
  recomputeTop();
  saveSoon();
  return {
    credited: true,
    inviterDeviceId: invitee.referrer,
    newCount: tally(inviter).active,
  };
}

function stats(deviceId) {
  const d = ensureDevice(deviceId);
  if (!d)
    return { code: null, credited: 0, invitedTotal: 0, hasReferrer: false };
  const t = tally(d);
  return {
    code: d.code,
    credited: t.active,
    invitedTotal: t.total,
    hasReferrer: !!d.referrer,
  };
}

// The people this device referred who count (pending or active), with whether
// each one is active yet. Touched-only and removed referrals are hidden - they
// are not real invites.
function invitees(deviceId) {
  const d = store.devices[deviceId];
  if (!d || !d.invited) return [];
  return Object.entries(d.invited)
    .filter(
      ([, r]) =>
        r && !r.removed && (r.state === "pending" || r.state === "active"),
    )
    .map(([id, r]) => ({
      deviceId: id,
      credited: r.state === "active",
      at: r.at || 0,
    }));
}

// Everyone who has at least one counting invite (pending OR active), ranked by
// active first (the metric that earns trophies and milestones), then pending,
// then total.
function leaderboard(limit = 100) {
  return Object.entries(store.devices)
    .map(([id, d]) => {
      const t = tally(d);
      return {
        deviceId: id,
        active: t.active,
        pending: t.pending,
        total: t.total,
      };
    })
    .filter((x) => x.total > 0)
    .sort(
      (a, b) => b.active - a.active || b.pending - a.pending || b.total - a.total,
    )
    .slice(0, Math.max(1, Math.min(limit, 200)));
}

// A device's position on the board, using the same ordering as leaderboard().
// Anyone who has at least one counting invite gets a rank; 0 means "not on it".
function rankOf(deviceId) {
  const me = store.devices[deviceId];
  if (!me) return 0;
  const mine = tally(me);
  if (mine.total <= 0) return 0;
  let rank = 1;
  for (const id in store.devices) {
    if (id === deviceId) continue;
    const t = tally(store.devices[id]);
    if (t.total <= 0) continue;
    if (
      t.active > mine.active ||
      (t.active === mine.active && t.pending > mine.pending) ||
      (t.active === mine.active &&
        t.pending === mine.pending &&
        t.total > mine.total)
    )
      rank++;
  }
  return rank;
}

// ── Staff forensics ─────────────────────────────────────────────────────────

// Largest count of timestamps within any windowMs span (times sorted ascending).
function maxInWindow(times, windowMs) {
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi++) {
    while (times[hi] - times[lo] > windowMs) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

// Turn raw signals into a plain-language verdict the dashboard can show, so a
// moderator reads a conclusion ("likely farmed - 99% one address, 1.0s
// cadence") instead of eyeballing rows.
function verdictFor(m) {
  const reasons = [];
  let score = 0;
  if (m.sus >= 10 && m.topIpPct >= 80) {
    score += 2;
    reasons.push(m.topIpPct + "% of pending from one address");
  } else if (m.sus >= 5 && m.topIpPct >= 60) {
    score += 1;
    reasons.push(m.topIpPct + "% of pending from one address");
  }
  if (m.medianGapMs != null && m.medianGapMs <= 3000 && m.sus >= 8) {
    score += 2;
    reasons.push(
      "~" + (m.medianGapMs / 1000).toFixed(1) + "s between invites (scripted)",
    );
  }
  if (m.largestBurst >= 10) {
    score += 1;
    reasons.push(m.largestBurst + " invites within 10 seconds");
  }
  if (m.sus >= 10 && m.namedPct <= 10) {
    score += 2;
    reasons.push("only " + m.namedPct + "% ever set a username");
  }
  if (m.sus >= 10 && m.activeCount === 0) {
    score += 1;
    reasons.push("none became active members");
  }
  let level = "clean";
  if (score >= 4) level = "likely_farmed";
  else if (score >= 2) level = "suspicious";
  return { level, score, reasons };
}

// Build the metrics + verdict for one inviter. idLookup(id) -> identity record
// (or null) lets us measure how many invitees ever chose a real username.
function metricsFor(d, idLookup) {
  const inv = (d && d.invited) || {};
  const recs = [];
  for (const k in inv) if (inv[k]) recs.push({ id: k, r: inv[k] });

  const counts = { touched: 0, pending: 0, active: 0, removed: 0 };
  for (const { r } of recs) {
    if (r.removed) counts.removed++;
    else counts[r.state] = (counts[r.state] || 0) + 1;
  }
  // The farmable population: live, not-yet-active referrals.
  const sus = recs.filter(({ r }) => !r.removed && r.state !== "active");
  const ipMap = {};
  for (const { r } of sus) {
    const ip = r.ip || "unknown";
    ipMap[ip] = (ipMap[ip] || 0) + 1;
  }
  const ips = Object.entries(ipMap)
    .map(([ip, count]) => ({ ip, count }))
    .sort((a, b) => b.count - a.count);
  const topIpPct = sus.length
    ? Math.round((100 * ((ips[0] && ips[0].count) || 0)) / sus.length)
    : 0;

  const times = recs
    .filter(({ r }) => !r.removed)
    .map(({ r }) => r.at)
    .filter(Boolean)
    .sort((a, b) => a - b);
  let medianGapMs = null;
  let largestBurst = 0;
  if (times.length >= 2) {
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    gaps.sort((a, b) => a - b);
    medianGapMs = gaps[Math.floor(gaps.length / 2)];
    largestBurst = maxInWindow(times, 10000);
  }

  // Conversion among everyone who counts or touched (excludes removed).
  const live = recs.filter(({ r }) => !r.removed);
  let named = 0;
  for (const { id } of live) {
    const rec = idLookup ? idLookup(id) : null;
    if (rec && !isGuestName(rec.name)) named++;
  }
  const namedPct = live.length ? Math.round((100 * named) / live.length) : 0;
  const activePct = live.length
    ? Math.round((100 * counts.active) / live.length)
    : 0;

  const verdict = verdictFor({
    sus: sus.length,
    topIpPct,
    medianGapMs,
    largestBurst,
    namedPct,
    activeCount: counts.active,
  });
  return {
    counts,
    suspectCount: sus.length,
    distinctIps: ips.length,
    topIpPct,
    medianGapMs,
    largestBurst,
    namedPct,
    activePct,
    ips, // raw; the caller redacts for non-devs
    verdict,
  };
}

// A full forensic report for one inviter, including purgeable cohorts (a cohort
// = all live not-yet-active invites sharing one IP, when there are enough to
// matter). The caller adds the display name and redacts raw IPs for mods.
function report(deviceId, idLookup) {
  const d = store.devices[deviceId];
  if (!d) return null;
  const m = metricsFor(d, idLookup);
  const cohorts = m.ips
    .filter((x) => x.ip !== "unknown" && x.count >= COHORT_MIN)
    .map((x) => ({ key: "ip:" + x.ip, ip: x.ip, count: x.count }));
  return Object.assign({ deviceId, code: d.code }, m, { cohorts });
}

// Inviters worth a staff look: anyone with enough pending to judge whose
// verdict is not "clean", sorted by suspicion. idLookup as in report().
function suspiciousInviters(idLookup, limit = 100) {
  const out = [];
  for (const id in store.devices) {
    const d = store.devices[id];
    const t = tally(d);
    if (t.pending < 5) continue; // not enough pending to judge
    const m = metricsFor(d, idLookup);
    if (m.verdict.level === "clean") continue;
    out.push({
      deviceId: id,
      pending: t.pending,
      active: t.active,
      suspectCount: m.suspectCount,
      distinctIps: m.distinctIps,
      topIpPct: m.topIpPct,
      namedPct: m.namedPct,
      verdict: m.verdict,
    });
  }
  out.sort((a, b) => b.verdict.score - a.verdict.score || b.pending - a.pending);
  return out.slice(0, limit);
}

// Soft-delete a flagged cohort of not-yet-active invites (an active invite is
// never touched). cohortKey is "ip:<addr>" or "all-flagged". Reversible via
// undoPurge. Returns { ok, removed, batch }.
function purgeCohort(deviceId, cohortKey, byLabel, reason) {
  const d = store.devices[deviceId];
  if (!d || !d.invited) return { ok: false, removed: 0 };
  const batch =
    "b" +
    Date.now().toString(36) +
    Math.floor(Math.random() * 1e6).toString(36);
  const now = Date.now();
  let removed = 0;
  for (const k in d.invited) {
    const r = d.invited[k];
    if (!r || r.removed || r.state === "active") continue;
    let match = false;
    if (cohortKey === "all-flagged") match = true;
    else if (cohortKey && cohortKey.indexOf("ip:") === 0)
      match = (r.ip || "unknown") === cohortKey.slice(3);
    if (!match) continue;
    r.removed = true;
    r.removedBy = byLabel || null;
    r.removedAt = now;
    r.reason = reason || null;
    r.batch = batch;
    removed++;
  }
  if (removed) {
    recomputeTop();
    saveSoon();
  }
  return { ok: removed > 0, removed, batch };
}

// Restore a soft-deleted batch (dev-only path). Returns { ok, restored }.
function undoPurge(deviceId, batch) {
  const d = store.devices[deviceId];
  if (!d || !d.invited || !batch) return { ok: false, restored: 0 };
  let restored = 0;
  for (const k in d.invited) {
    const r = d.invited[k];
    if (!r || !r.removed || r.batch !== batch) continue;
    delete r.removed;
    delete r.removedBy;
    delete r.removedAt;
    delete r.reason;
    delete r.batch;
    restored++;
  }
  if (restored) {
    recomputeTop();
    saveSoon();
  }
  return { ok: restored > 0, restored };
}

// Is this device worth keeping? It has counting invites, or is itself a real
// (pending/active) invitee. Touched-only drive-by devices are NOT, so a bot
// that mints a fresh id per hit gets pruned instead of filling the store.
function hasValue(id) {
  const d = store.devices[id];
  if (!d) return false;
  if (tally(d).total > 0) return true;
  if (d.referrer) {
    const inv = store.devices[d.referrer];
    const r = inv && inv.invited && inv.invited[id];
    if (r && !r.removed && (r.state === "pending" || r.state === "active"))
      return true;
  }
  return false;
}

function prune() {
  const now = Date.now();
  // 1) Expire stale invite records.
  for (const id in store.devices) {
    const inv = store.devices[id].invited;
    if (!inv) continue;
    for (const k in inv) {
      const r = inv[k];
      if (!r) {
        delete inv[k];
      } else if (r.removed) {
        if (now - (r.removedAt || 0) > REMOVED_TTL) delete inv[k];
      } else if (r.state === "touched") {
        if (now - (r.at || 0) > TOUCHED_TTL) delete inv[k];
      } else if (r.state === "pending") {
        if (now - (r.pendingAt || r.at || 0) > PENDING_TTL) delete inv[k];
      }
      // active never expires
    }
  }
  // 2) Drop valueless devices: stale touched-only/inert ones, then (if still
  //    over the cap) the oldest valueless by last activity.
  const drop = (id) => {
    const d = store.devices[id];
    if (d && d.code && store.codes[d.code] === id) delete store.codes[d.code];
    if (d && d.referrer) {
      const inv = store.devices[d.referrer];
      if (inv && inv.invited) delete inv.invited[id];
    }
    delete store.devices[id];
  };
  for (const id of Object.keys(store.devices))
    if (!hasValue(id) && now - (store.devices[id].lastSeen || 0) > TOUCHED_TTL)
      drop(id);
  const ids = Object.keys(store.devices);
  if (ids.length > MAX_DEVICES) {
    ids
      .filter((id) => !hasValue(id))
      .sort(
        (a, b) =>
          (store.devices[a].lastSeen || 0) - (store.devices[b].lastSeen || 0),
      )
      .slice(0, ids.length - MAX_DEVICES)
      .forEach(drop);
  }
  recomputeTop();
}

// Synchronous write for a clean shutdown (survives the debounce window).
function flushSync() {
  try {
    prune();
    const tmp = INV_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store), "utf8");
    fs.renameSync(tmp, INV_PATH);
  } catch (e) {
    console.error("invites flush failed:", e);
  }
}

load();
recomputeTop();

module.exports = {
  ensureDevice,
  codeFor,
  recordIp,
  setReferrer,
  promoteIfEarned,
  creditIfEligible,
  stats,
  invitees,
  leaderboard,
  rankOf,
  rankBadge,
  report,
  suspiciousInviters,
  purgeCohort,
  undoPurge,
  isGuestName,
  flushSync,
  MILESTONE_MOD,
  MILESTONE_DEV,
};
