// server/games/flagcdn.js
// Flag images, fetched once from flagcdn.net and then served from here.
//
// The point of the proxy is secrecy. A browser asking flagcdn for
// "w640/ua.png" has the answer sitting in the network tab, the DOM and the
// image cache, so the game would be over before it started. Instead the server
// hands out an opaque token per round, and the bytes come back from our own
// origin with nothing in the url, the path or the headers that names the
// country.
//
// Images are cached in memory: 200-odd flags at ~15KB is nothing, and it means
// a round never waits on somebody else's CDN.

const crypto = require("crypto");

const SIZE = "w640"; // wide enough to fill a canvas on a big screen
const ORIGIN = "https://flagcdn.com";
const FETCH_TIMEOUT_MS = 8000;
const TOKEN_TTL_MS = 60 * 60 * 1000; // a token outlives its round by a margin

const images = new Map(); // code -> { buf, at } | { pending: Promise }
const tokens = new Map(); // token -> { code, at }

function sweep() {
  const now = Date.now();
  for (const [t, rec] of tokens)
    if (now - rec.at > TOKEN_TTL_MS) tokens.delete(t);
}
setInterval(sweep, 10 * 60 * 1000).unref();

// A fresh opaque handle for one flag. Two rounds showing the same country get
// different tokens, so nobody can learn a mapping by playing twice.
function tokenFor(code) {
  const token = crypto.randomBytes(12).toString("hex");
  tokens.set(token, { code, at: Date.now() });
  return token;
}

function codeForToken(token) {
  const rec = tokens.get(String(token || ""));
  return rec ? rec.code : null;
}

async function download(code) {
  const url = `${ORIGIN}/${SIZE}/${encodeURIComponent(code)}.png`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { "User-Agent": "Talkomatic/1.0 (+https://talkomatic.co)" },
    });
    if (!res.ok) throw new Error("flagcdn " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("empty flag");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

// Bytes for a country, from memory when we have them. Concurrent callers for
// the same flag share one download rather than starting a stampede.
function imageFor(code) {
  const hit = images.get(code);
  if (hit && hit.buf) return Promise.resolve(hit.buf);
  if (hit && hit.pending) return hit.pending;
  const pending = download(code)
    .then((buf) => {
      images.set(code, { buf, at: Date.now() });
      return buf;
    })
    .catch((err) => {
      images.delete(code); // let the next round try again
      throw err;
    });
  images.set(code, { pending });
  return pending;
}

// Pull a game's flags down before anybody is waiting on them, so the first
// round does not open on a blank canvas while we talk to a CDN.
function warm(codes) {
  for (const code of codes) imageFor(code).catch(() => {});
}

function has(code) {
  const hit = images.get(code);
  return !!(hit && hit.buf);
}

module.exports = { tokenFor, codeForToken, imageFor, warm, has, SIZE };
