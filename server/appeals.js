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
// Persisted to appeals.json the same way as the other JSON stores (atomic
// tmp + rename, debounced), capped, pruned, and never committed.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "appeals.json");
const MAX = 2000;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // keep appeals for 30 days

let appeals = []; // oldest first
let seq = 0;
let saveTimer = null;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    appeals = Array.isArray(arr) ? arr : [];
    seq = appeals.reduce((m, a) => Math.max(m, a.id || 0), 0);
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
  const a = {
    id: ++seq,
    ip,
    deviceId: deviceId || null,
    userId: userId || null,
    name: name || null,
    message: message || "",
    at: Date.now(),
    status: "open", // open | resolved
    resolution: null, // lifted | dismissed
    reviewedBy: null,
    reviewedAt: null,
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

// Resolve one appeal (staff lifted the ban, or dismissed the appeal).
function resolve(id, resolution, reviewedBy) {
  const a = get(id);
  if (!a) return null;
  a.status = "resolved";
  a.resolution = resolution || "dismissed";
  a.reviewedBy = reviewedBy || null;
  a.reviewedAt = Date.now();
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
  resolve,
  resolveOpenForIp,
  openForIp,
  openCount,
  list,
  flushSync,
};
