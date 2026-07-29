// server/nsfw-worker.js
// Worker-thread half of the puzzle NSFW check (see server/nsfw.js). Loads the
// bundled nsfwjs MobileNet model once and classifies JPEG buffers posted to
// it, so the ~1-2s of CPU per scan never blocks the main event loop (chat,
// pong ticks, socket traffic keep flowing during an upload).

const { parentPort } = require("worker_threads");
const fs = require("fs");
const path = require("path");
const tf = require("@tensorflow/tfjs");
const jpeg = require("jpeg-js");

const MODEL_DIR = path.join(__dirname, "..", "public", "models", "nsfw");
// nsfwjs class order (alphabetical, fixed by the model's training)
const CLASSES = ["Drawing", "Hentai", "Neutral", "Porn", "Sexy"];

// Slightly stricter than the old client thresholds.
const LIMITS = { Porn: 0.25, Hentai: 0.25, Sexy: 0.45, sum: 0.5 };

let modelPromise = null;

function loadModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const modelJson = JSON.parse(
        fs.readFileSync(path.join(MODEL_DIR, "model.json"), "utf8"),
      );
      const weightSpecs = [];
      const buffers = [];
      for (const group of modelJson.weightsManifest) {
        weightSpecs.push(...group.weights);
        for (const p of group.paths)
          buffers.push(fs.readFileSync(path.join(MODEL_DIR, p)));
      }
      const raw = Buffer.concat(buffers);
      const weightData = raw.buffer.slice(
        raw.byteOffset,
        raw.byteOffset + raw.byteLength,
      );
      const handler = {
        load: async () => ({
          modelTopology: modelJson.modelTopology,
          weightSpecs,
          weightData,
        }),
      };
      const model = await tf.loadLayersModel(handler);
      // Warmup inference so the first real scan is not slow
      const zero = tf.zeros([1, 224, 224, 3]);
      const out = model.predict(zero);
      await out.data();
      zero.dispose();
      out.dispose();
      return model;
    })();
    modelPromise.catch(() => {
      modelPromise = null;
    });
  }
  return modelPromise;
}

// Classify one region of the decoded image. region = {x, y, w, h}.
async function classifyRegion(model, px, imgW, region) {
  const input = tf.tidy(() => {
    const rgb = new Float32Array(region.w * region.h * 3);
    let o = 0;
    for (let yy = 0; yy < region.h; yy++) {
      let src = ((region.y + yy) * imgW + region.x) * 4;
      for (let xx = 0; xx < region.w; xx++) {
        rgb[o++] = px[src];
        rgb[o++] = px[src + 1];
        rgb[o++] = px[src + 2];
        src += 4;
      }
    }
    const t = tf.tensor3d(rgb, [region.h, region.w, 3]);
    return tf.image.resizeBilinear(t, [224, 224]).div(255).expandDims(0);
  });
  const logits = model.predict(input);
  const probs = await logits.data();
  input.dispose();
  logits.dispose();
  const out = {};
  CLASSES.forEach((c, i) => (out[c] = probs[i] || 0));
  return out;
}

async function scanJpeg(buf) {
  const model = await loadModel();
  const img = jpeg.decode(buf, {
    maxMemoryUsageInMB: 160,
    formatAsRGBA: true,
    tolerantDecoding: true,
  });
  if (!img || !img.width || !img.height || img.width * img.height > 16e6)
    throw new Error("bad image");

  // Whole frame plus a centre crop, keeping the worst score per class - the
  // same recipe as the browser pre-check.
  const s = Math.min(img.width, img.height);
  const regions = [
    { x: 0, y: 0, w: img.width, h: img.height },
    {
      x: Math.floor((img.width - s) / 2),
      y: Math.floor((img.height - s) / 2),
      w: s,
      h: s,
    },
  ];
  const worst = { Drawing: 0, Hentai: 0, Neutral: 1, Porn: 0, Sexy: 0 };
  for (const region of regions) {
    const scores = await classifyRegion(model, img.data, img.width, region);
    worst.Porn = Math.max(worst.Porn, scores.Porn);
    worst.Hentai = Math.max(worst.Hentai, scores.Hentai);
    worst.Sexy = Math.max(worst.Sexy, scores.Sexy);
    worst.Drawing = Math.max(worst.Drawing, scores.Drawing);
    worst.Neutral = Math.min(worst.Neutral, scores.Neutral);
  }

  const bad =
    worst.Porn > LIMITS.Porn ||
    worst.Hentai > LIMITS.Hentai ||
    worst.Sexy > LIMITS.Sexy ||
    worst.Porn + worst.Hentai + worst.Sexy > LIMITS.sum;
  return { safe: !bad, scores: worst };
}

parentPort.on("message", (msg) => {
  if (!msg || typeof msg.id === "undefined") return;
  if (msg.warmup) {
    loadModel()
      .then(() => parentPort.postMessage({ id: msg.id, ok: true }))
      .catch((e) =>
        parentPort.postMessage({ id: msg.id, ok: false, error: e.message }),
      );
    return;
  }
  scanJpeg(Buffer.from(msg.buf))
    .then((verdict) => parentPort.postMessage({ id: msg.id, ok: true, verdict }))
    .catch((e) =>
      parentPort.postMessage({ id: msg.id, ok: false, error: e.message }),
    );
});
