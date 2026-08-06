// server/modwatch.js
// Lightweight, tunable mod-abuse detector. It keeps a short rolling log of each
// mod key's recent privileged actions and raises a single staff notification
// (full mods + devs) when the pattern looks like misuse: too many actions in 5
// or 60 minutes, a lopsided share of kicks, hammering one user, or spraying
// many users in a burst. It never auto-punishes; it just surfaces the pattern
// with the mod's recent actions attached. In-memory only; resets on restart.

const audit = require("./audit");

const SHORT_MS = 5 * 60 * 1000;
const LONG_MS = 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // at most one flag per key per cooldown
const MAX_LOG = 60; // recent actions kept per key
const MAX_KEYS = 2000;

// Thresholds, all tunable in one place.
const THRESHOLDS = {
  short5: 12, // more than this many actions in 5 min
  long60: 60, // more than this many actions in 60 min
  minForShare: 8, // need at least this many recent actions to judge kick share
  kickShare: 0.7, // and this fraction of them being kicks
  sameTarget: 4, // same user hit this many times in 5 min
  distinctBurst: 6, // this many different users hit in 5 min
};

const log = new Map(); // hash -> [{ at, action, target, kick }]
const lastAlert = new Map(); // hash -> ts

function isKick(action) {
  return /kick/i.test(action || "");
}

function targetName(target) {
  const m = /^user:(.*)\(/.exec(target || "");
  return m ? m[1] : target || "";
}

function evictOldest() {
  let oldest = null;
  let ts = Infinity;
  for (const [h, a] of log) {
    const last = a.length ? a[a.length - 1].at : 0;
    if (last < ts) {
      ts = last;
      oldest = h;
    }
  }
  if (oldest) {
    log.delete(oldest);
    lastAlert.delete(oldest);
  }
}

// Record one privileged action by a mod key and flag if the pattern trips.
function record({ hash, label, role, action, target, room, ip }) {
  if (!hash) return;
  const now = Date.now();
  let arr = log.get(hash) || [];
  arr.push({ at: now, action: action || "?", target: target || null, kick: isKick(action) });
  arr = arr.filter((e) => now - e.at <= LONG_MS);
  if (arr.length > MAX_LOG) arr = arr.slice(-MAX_LOG);
  log.set(hash, arr);
  if (log.size > MAX_KEYS) evictOldest();

  const recent5 = arr.filter((e) => now - e.at <= SHORT_MS);
  const reasons = [];

  if (recent5.length > THRESHOLDS.short5)
    reasons.push(`${recent5.length} actions in 5 min`);
  if (arr.length > THRESHOLDS.long60)
    reasons.push(`${arr.length} actions in 60 min`);

  const kicks5 = recent5.filter((e) => e.kick).length;
  if (
    recent5.length >= THRESHOLDS.minForShare &&
    kicks5 / recent5.length >= THRESHOLDS.kickShare
  )
    reasons.push(`${Math.round((kicks5 / recent5.length) * 100)}% of recent actions are kicks`);

  const targetCounts = {};
  for (const e of recent5)
    if (e.target) targetCounts[e.target] = (targetCounts[e.target] || 0) + 1;
  let maxSame = 0;
  let maxSameName = "";
  for (const t in targetCounts)
    if (targetCounts[t] > maxSame) {
      maxSame = targetCounts[t];
      maxSameName = targetName(t);
    }
  if (maxSame >= THRESHOLDS.sameTarget)
    reasons.push(`hit ${maxSameName || "one user"} ${maxSame} times in 5 min`);

  const distinct = Object.keys(targetCounts).length;
  if (distinct >= THRESHOLDS.distinctBurst)
    reasons.push(`hit ${distinct} different users in 5 min`);

  if (!reasons.length) return;
  if (now - (lastAlert.get(hash) || 0) < ALERT_COOLDOWN_MS) return;
  lastAlert.set(hash, now);

  const who = label || role || "A moderator";
  const recentList = arr
    .slice(-10)
    .map((e) => e.action + (e.target ? " > " + targetName(e.target) : ""))
    .join(", ");
  audit.recordNotification({
    kind: "abuse",
    role: role || "mod",
    label: who,
    text: `Possible mod abuse by ${who}: ${reasons.join("; ")}. Recent actions: ${recentList}.`,
    room: room || null,
    ip: ip || null, // the mod's own address, dev-only
    minLevel: 2,
    // Read as a list rather than a paragraph: what tripped it, then what they
    // actually did. The flag is a prompt to go and look, never a verdict.
    card: {
      target: who,
      targetRole: role || "mod",
      reason: reasons.join("; "),
      lines: arr
        .slice(-10)
        .map((e) => e.action + (e.target ? " > " + targetName(e.target) : "")),
    },
  });
}

module.exports = { record };
