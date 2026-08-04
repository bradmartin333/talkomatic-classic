// server/reports.js
// Tally of user reports so staff can see how many distinct people reported
// someone, and why. Persisted to disk so the board survives a restart; the
// individual reports also flow into the audit feed for the permanent record.
// "distinct" counts unique reporters by device, so one person spamming the
// report button cannot inflate the number.
//
// Each report also remembers the target's last-known IP, device id, and role
// (captured while they were online). That lets staff act on a reported user
// from the board even after they disconnect, without ever exposing the raw IP
// to a moderator (the server resolves it). The role is kept so the staff
// hierarchy still holds when the target is offline and we cannot read it live.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "reports.json");

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // keep a target's reports for 7 days
const MAX_TARGETS = 5000;
const MAX_PER_TARGET = 100;

let byTarget = new Map(); // targetKey -> [{ byDeviceId, byName, category, reason, at, targetIp, targetDeviceId, targetRole, targetText }]
let resolutions = new Map(); // targetKey -> { action, by, duration, at } once staff acted
let saveTimer = null;
let dirty = false;

function load() {
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const obj = JSON.parse(raw);
    byTarget = new Map();
    resolutions = new Map();
    if (obj && typeof obj === "object") {
      // v2 wraps everything in { targets, resolutions }; v1 was a bare
      // targetKey -> array object, so fall back to reading the root.
      const targets =
        obj.targets && typeof obj.targets === "object" && !Array.isArray(obj.targets)
          ? obj.targets
          : obj;
      for (const [k, arr] of Object.entries(targets))
        if (Array.isArray(arr)) byTarget.set(k, arr);
      if (obj.resolutions && typeof obj.resolutions === "object")
        for (const [k, r] of Object.entries(obj.resolutions))
          if (r && typeof r === "object" && byTarget.has(k)) resolutions.set(k, r);
    }
    prune(Date.now());
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Error loading reports.json:", err);
    byTarget = new Map();
    resolutions = new Map();
  }
}

function serialize() {
  return JSON.stringify({
    targets: Object.fromEntries(byTarget),
    resolutions: Object.fromEntries(resolutions),
  });
}

// Atomic write (tmp + rename), debounced, mirrors the other JSON stores.
function saveSoon() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, serialize(), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("reports save failed:", e);
    }
  }, 3000);
}

// Synchronous write for a clean shutdown, so a report filed seconds before a
// restart is not lost inside the debounce window.
function flushSync() {
  try {
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, serialize(), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("reports flush failed:", e);
  }
}

function prune(now) {
  for (const [k, arr] of byTarget) {
    const fresh = arr.filter((r) => now - r.at <= WINDOW_MS);
    if (fresh.length) byTarget.set(k, fresh);
    else byTarget.delete(k);
  }
  if (byTarget.size > MAX_TARGETS) {
    const keys = [...byTarget.keys()];
    for (let i = 0; i < keys.length - MAX_TARGETS; i++) byTarget.delete(keys[i]);
  }
  for (const k of resolutions.keys()) if (!byTarget.has(k)) resolutions.delete(k);
}

function distinctReporters(list) {
  const ids = new Set();
  let anon = 0;
  for (const r of list) {
    if (r.byDeviceId) ids.add(r.byDeviceId);
    else anon++;
  }
  return ids.size + (anon > 0 ? 1 : 0);
}

// Record a report and return { total, distinct } for the target.
function add({
  targetKey,
  targetName,
  byDeviceId,
  byName,
  category,
  reason,
  targetIp,
  targetDeviceId,
  targetRole,
  targetText,
}) {
  if (!targetKey) return { total: 0, distinct: 0 };
  const now = Date.now();
  let arr = byTarget.get(targetKey);
  if (!arr) {
    arr = [];
    byTarget.set(targetKey, arr);
  }
  arr.push({
    targetName: targetName || null,
    byDeviceId: byDeviceId || null,
    byName: byName || null,
    category: category || "other",
    reason: reason || null,
    at: now,
    targetIp: targetIp || null,
    targetDeviceId: targetDeviceId || null,
    targetRole: targetRole || null,
    // What the reported user had typed in their chat box at report time, so
    // staff can see the offending text even after it is cleared or they leave.
    targetText: targetText || null,
  });
  if (arr.length > MAX_PER_TARGET) arr.splice(0, arr.length - MAX_PER_TARGET);
  // A fresh report reopens a handled case, so the card shows as active again.
  resolutions.delete(targetKey);
  prune(now);
  saveSoon();
  const list = byTarget.get(targetKey) || [];
  return { total: list.length, distinct: distinctReporters(list) };
}

// All recent reports against one target (for a dashboard drill-down).
function forTarget(targetKey) {
  return (byTarget.get(targetKey) || []).slice();
}

// The most recent IP, device id, name, and role we ever captured for a target,
// so staff can act on them once they go offline. Each field is taken from the
// newest report that carries it.
function lastKnown(targetKey) {
  const arr = byTarget.get(targetKey);
  if (!arr || !arr.length) return null;
  let ip = null,
    deviceId = null,
    name = null,
    role = null;
  for (let i = arr.length - 1; i >= 0; i--) {
    const r = arr[i];
    if (!ip && r.targetIp) ip = r.targetIp;
    if (!deviceId && r.targetDeviceId) deviceId = r.targetDeviceId;
    if (!name && r.targetName) name = r.targetName;
    if (!role && r.targetRole) role = r.targetRole;
  }
  return { ip, deviceId, name, role };
}

// Drop every report against one target (staff discarded it as false/handled).
function clear(targetKey) {
  const had = byTarget.delete(targetKey);
  resolutions.delete(targetKey);
  if (had) saveSoon();
  return had;
}

// Stamp a target's reports as handled (warned / ip blocked / kicked), so the
// board shows who took action instead of leaving the card looking untouched.
function resolve(targetKey, { action, by, duration } = {}) {
  if (!targetKey || !action || !byTarget.has(targetKey)) return false;
  resolutions.set(targetKey, {
    action,
    by: by || null,
    duration: duration || null,
    at: Date.now(),
  });
  saveSoon();
  return true;
}

// Compact per-target summary, most-reported first (for a dashboard view).
function summary() {
  const out = [];
  for (const [targetKey, arr] of byTarget) {
    const cats = {};
    for (const r of arr) cats[r.category] = (cats[r.category] || 0) + 1;
    out.push({
      targetKey,
      name: arr.length ? arr[arr.length - 1].targetName : null,
      total: arr.length,
      distinct: distinctReporters(arr),
      categories: cats,
      first: arr.length ? arr[0].at : 0,
      last: arr.length ? arr[arr.length - 1].at : 0,
      resolution: resolutions.get(targetKey) || null,
    });
  }
  return out.sort((a, b) => b.distinct - a.distinct || b.total - a.total);
}

load();

// Is this user currently on the reports board (for live dashboard refreshes)?
function isTarget(targetKey) {
  return !!targetKey && byTarget.has(targetKey);
}

module.exports = {
  add,
  forTarget,
  lastKnown,
  summary,
  clear,
  resolve,
  isTarget,
  flushSync,
};
