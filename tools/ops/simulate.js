// Simulated-user engine: spins up N socket.io-client connections against a
// running server to exercise room capacity, seat-yielding and the tiling
// breakpoints. Extracted from the old standalone simulate-users.js so both
// the `ops.js simulate` subcommand and the interactive menu's "Simulate
// users" mode share one implementation.
//
// Activity is steerable at runtime (idle/active/add/drop) because a queue
// only forms when the room is full AND occupants have gone quiet, which is
// impossible to stage with static flags.
//
// Run this against your OWN local dev server only - never a shared/remote
// one. Simulated users connect as HUMANS by default (spoofed browser
// headers, no bot token) - NOT as bots. Bots are exempt from idle-eviction
// (server/rooms.js:isUserEvictable), and the server outright rejects a bot
// token from anything that looks like a browser, so there is no in-between.
// Pass asBot to instead go through the bot-token flow and verify the
// OPPOSITE thing: that bot occupants never yield their seat.

const { io } = require("socket.io-client");

// Score >= 3 of 4 in server/security.js's detectBrowserRequest() to be
// treated as a real browser rather than a bot. Node's socket.io-client won't
// send these on its own the way a real browser does - has to be spelled out.
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
};

// One token, many sockets. Token requests are capped at 3/hour and 3 active
// per IP, but nothing limits how many connections reuse a single token - so
// asking for one per simulated user makes 10 users impossible locally.
async function requestToken(server) {
  let res;
  try {
    res = await fetch(`${server}/api/v1/bot-tokens/request`, { method: "POST" });
  } catch (err) {
    // Node's fetch collapses every network failure to the unhelpful message
    // "fetch failed" and buries the real reason in err.cause.
    throw new Error(
      `Could not reach ${server} (${err.cause?.code || err.cause?.message || err.message}). ` +
        `Is the server running? Start it in another terminal:\n` +
        `  IDLE_THRESHOLD_MS=15000 npm start`,
    );
  }
  if (!res.ok) {
    throw new Error(
      `Token request failed (${res.status}). Tokens are limited to 3/hour ` +
        `per IP; reuse one via --token if you have hit that.`,
    );
  }
  return (await res.json()).token;
}

// opts: { server, roomId, accessCode, asBot, chatIntervalMs, log }
// `log(message)` is called for every async event line (join/queue/evict/
// error/disconnect/etc.) - the caller is responsible for not letting that
// output clobber an active readline prompt (see ops.js's log() helper).
function createSession(opts) {
  const { server, roomId, accessCode = null, asBot = false, chatIntervalMs = 3000, log } = opts;
  const users = [];

  function spawn(token, index) {
    const name = `Sim${String(index).padStart(2, "0")}`;
    const socket = asBot
      ? io(server, { auth: { token }, transports: ["websocket"], reconnection: false })
      : io(server, {
          // No token: looking like a browser and carrying one is rejected
          // outright (server.js: "Bot tokens not allowed in browsers").
          extraHeaders: BROWSER_HEADERS,
          transports: ["websocket"],
          reconnection: false,
        });

    const user = { index, name, socket, active: false, state: "connecting", timer: null, tick: 0 };

    socket.on("connect", () => {
      socket.emit("join lobby", { username: name, location: "Harness" });
    });

    socket.on("signin status", (data) => {
      if (!data?.isSignedIn) return;
      user.userId = data.userId;
      const payload = { roomId };
      if (accessCode) payload.accessCode = accessCode;
      socket.emit("join room", payload);
    });

    socket.on("room joined", () => {
      user.state = "in-room";
      log(`[${user.name}] joined the room`);
    });

    socket.on("room queued", (data) => {
      user.state = `queued#${data?.position ?? "?"}`;
      log(`[${user.name}] queued at position ${data?.position ?? "?"}`);
    });

    socket.on("room capacity evicted", (data) => {
      user.state = "evicted";
      log(`[${user.name}] yielded its seat in ${data?.roomName ?? roomId}`);
    });

    socket.on("room full", () => {
      user.state = "refused";
      log(`[${user.name}] refused: room full`);
    });

    socket.on("room closed", (data) => {
      user.state = "room-closed";
      log(`[${user.name}] room closed: ${data?.message ?? ""}`);
    });

    socket.on("kicked", () => {
      user.state = "kicked";
      log(`[${user.name}] voted out`);
    });

    socket.on("error", (err) => {
      log(`[${user.name}] error: ${err?.error?.message ?? JSON.stringify(err)}`);
    });

    socket.on("validation_error", (err) => {
      log(`[${user.name}] validation error: ${JSON.stringify(err)}`);
    });

    socket.on("connect_error", (err) => {
      user.state = "connect-failed";
      log(`[${user.name}] connect failed: ${err.message}`);
      if (/Too many connections/i.test(err.message)) {
        log(
          `[${user.name}] hit MAX_CONNECTIONS_PER_IP (default now covers a full room; ` +
            "raise it further for a bigger test, e.g. MAX_CONNECTIONS_PER_IP=60)",
        );
      }
    });

    socket.on("disconnect", (reason) => {
      user.state = "disconnected";
      log(`[${user.name}] disconnected (${reason})`);
      stopActivity(user);
    });

    users.push(user);
    return user;
  }

  function startActivity(user) {
    if (user.timer) return;
    user.active = true;
    user.timer = setInterval(() => {
      if (!user.socket.connected) return;
      user.tick += 1;
      user.socket.emit("chat update", {
        diff: { type: "full-replace", text: `${user.name} still here #${user.tick}` },
      });
    }, chatIntervalMs);
  }

  function stopActivity(user) {
    user.active = false;
    if (user.timer) {
      clearInterval(user.timer);
      user.timer = null;
    }
  }

  function pick(token) {
    if (token === "all") return users.filter((u) => u.socket.connected);
    const n = Number(token);
    const user = users.find((u) => u.index === n);
    return user ? [user] : [];
  }

  function listText() {
    const lines = ["  #   name     activity  state"];
    for (const u of users) {
      lines.push(
        `  ${String(u.index).padEnd(3)} ${u.name.padEnd(8)} ` +
          `${(u.active ? "active" : "idle").padEnd(9)} ${u.state}`,
      );
    }
    return lines.join("\n");
  }

  async function spawnBatch(token, count, idleCount) {
    for (let i = 1; i <= count; i++) {
      const user = spawn(token, i);
      if (i > idleCount) startActivity(user);
      // Stagger so join order (and therefore "longest present") is deterministic.
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async function add(token, k = 1) {
    for (let i = 0; i < k; i++) {
      const user = spawn(token, users.length + 1);
      startActivity(user);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  function setActive(selector, active) {
    pick(selector).forEach((u) => {
      if (active) startActivity(u);
      else stopActivity(u);
      log(`[${u.name}] now ${active ? "active" : "idle"}`);
    });
  }

  function drop(selector) {
    pick(selector).forEach((u) => {
      stopActivity(u);
      u.socket.disconnect();
    });
  }

  function shutdown() {
    for (const u of users) {
      stopActivity(u);
      if (u.socket.connected) {
        u.socket.emit("leave room");
        u.socket.disconnect();
      }
    }
  }

  return { users, spawnBatch, add, setActive, drop, listText, shutdown };
}

module.exports = { createSession, requestToken };
