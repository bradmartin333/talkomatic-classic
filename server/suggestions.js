// server/suggestions.js
// Feature suggestions users file from the lobby. Devs and full mods review them
// in the dashboard and approve or decline. Same flat-array JSON store as appeals.

const path = require("path");
const fs = require("fs");
const fsp = require("fs").promises;

const { DATA_DIR } = require("./datadir");

const STORE_PATH = path.join(DATA_DIR, "suggestions.json");
const MAX = 2000;
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

let suggestions = []; // oldest first
let seq = 0;
let saveTimer = null;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    suggestions = Array.isArray(arr) ? arr : [];
    seq = suggestions.reduce((m, s) => Math.max(m, s.id || 0), 0);
    prune(Date.now());
  } catch (err) {
    if (err.code !== "ENOENT")
      console.error("Error loading suggestions.json:", err);
    suggestions = [];
  }
}

function saveSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      if (suggestions.length > MAX) suggestions = suggestions.slice(-MAX);
      const tmp = STORE_PATH + ".tmp";
      await fsp.writeFile(tmp, JSON.stringify(suggestions, null, 2), "utf8");
      await fsp.rename(tmp, STORE_PATH);
    } catch (e) {
      console.error("suggestions save failed:", e);
    }
  }, 3000);
}

function flushSync() {
  try {
    if (suggestions.length > MAX) suggestions = suggestions.slice(-MAX);
    const tmp = STORE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(suggestions, null, 2), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (e) {
    console.error("suggestions flush failed:", e);
  }
}

function prune(now) {
  suggestions = suggestions.filter((s) => now - (s.at || 0) <= WINDOW_MS);
  if (suggestions.length > MAX) suggestions = suggestions.slice(-MAX);
}

function submit({ deviceId, userId, name, text }) {
  if (!text) return { ok: false, code: "empty" };
  const s = {
    id: ++seq,
    deviceId: deviceId || null,
    userId: userId || null,
    name: name || null,
    text,
    at: Date.now(),
    status: "open", // open | resolved
    resolution: null, // approved | declined
    reviewedBy: null,
    reviewedAt: null,
  };
  suggestions.push(s);
  prune(Date.now());
  saveSoon();
  return { ok: true, id: s.id };
}

function get(id) {
  return suggestions.find((s) => s.id === id) || null;
}

function resolve(id, resolution, reviewedBy) {
  const s = get(id);
  if (!s) return null;
  s.status = "resolved";
  s.resolution = resolution || "declined";
  s.reviewedBy = reviewedBy || null;
  s.reviewedAt = Date.now();
  saveSoon();
  return s;
}

function openCount() {
  return suggestions.reduce((n, s) => n + (s.status === "open" ? 1 : 0), 0);
}

function list() {
  return suggestions.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
}

load();

module.exports = { submit, get, resolve, openCount, list, flushSync };
