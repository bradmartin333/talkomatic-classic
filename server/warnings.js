// server/warnings.js
// Pending staff warnings for users who are offline, keyed by the durable device
// id and delivered on their next connect so a warning is never lost. Persisted
// to warnings.json; load() tolerates old/missing fields (migrates forward).

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "warnings.json");
const MAX_PER_DEVICE = 5;
const TTL = 30 * 24 * 60 * 60 * 1000; // drop undelivered after 30 days

let store = {}; // deviceId -> [{ message, by, at }]
let saveTimer = null;

function load() {
  try {
    const o = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (o && typeof o === "object") store = o;
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading warnings.json:", err);
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(store), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("warnings save failed:", e);
    }
  }, 1500);
}

function flushSync() {
  try {
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("warnings flush failed:", e);
  }
}

// Queue a warning for delivery on the device's next connect.
function queue(deviceId, message, by) {
  if (!deviceId || !message) return;
  const arr = store[deviceId] || (store[deviceId] = []);
  arr.push({
    message: String(message).slice(0, 1000),
    by: by || null,
    at: Date.now(),
  });
  if (arr.length > MAX_PER_DEVICE) arr.splice(0, arr.length - MAX_PER_DEVICE);
  saveSoon();
}

// Return and clear a device's pending (non-expired) warnings.
function takeFor(deviceId) {
  if (!deviceId || !store[deviceId]) return [];
  const now = Date.now();
  const out = store[deviceId].filter((w) => now - (w.at || 0) <= TTL);
  delete store[deviceId];
  saveSoon();
  return out;
}

load();

module.exports = { queue, takeFor, flushSync };
