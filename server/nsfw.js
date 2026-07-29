// server/nsfw.js
// Server-side NSFW check for puzzle image uploads. The browser scan is a fast
// pre-check, but its result is self-reported and can be forged; this module
// classifies the ACTUAL uploaded JPEG bytes with the bundled nsfwjs model in
// a worker thread (server/nsfw-worker.js), so the CPU cost never blocks the
// main event loop. Fails closed: if the worker or model breaks, uploads are
// rejected, never waved through.

const path = require("path");
const { Worker } = require("worker_threads");

const SCAN_TIMEOUT_MS = 20000;

let worker = null;
let seq = 0;
let modelReady = false; // true once the model has loaded at least once
const pending = new Map(); // id -> { resolve, reject, timer }

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, "nsfw-worker.js"));
  worker.unref();
  worker.on("message", (msg) => {
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) entry.resolve(msg.verdict);
    else entry.reject(new Error(msg.error || "scan failed"));
  });
  const fail = (why) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(why));
      pending.delete(id);
    }
    worker = null; // next scan spawns a fresh worker
  };
  worker.on("error", (e) => fail("nsfw worker error: " + e.message));
  worker.on("exit", (code) => {
    if (code !== 0) fail("nsfw worker exited " + code);
    else worker = null;
  });
  return worker;
}

function call(payload) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("scan timed out"));
    }, SCAN_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    try {
      ensureWorker().postMessage({ id, ...payload });
    } catch (e) {
      pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

// Scan a JPEG buffer. Resolves { safe, scores }; rejects on any failure -
// callers must treat a rejection as a blocked upload (fail closed).
function scanJpeg(buf) {
  return call({ buf }).then((verdict) => {
    modelReady = true;
    return verdict;
  });
}

// Fire at boot so the first upload does not pay the model-load cost.
function warmup() {
  call({ warmup: true })
    .then(() => {
      modelReady = true;
    })
    .catch((e) =>
      console.error("NSFW model preload failed (will retry on upload):", e.message),
    );
}

// Health endpoint: has the scanner successfully loaded its model.
function isReady() {
  return modelReady;
}

module.exports = { scanJpeg, warmup, isReady };
