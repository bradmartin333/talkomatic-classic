#!/usr/bin/env node
// Spin up N simulated users against a running server to exercise room
// capacity, seat-yielding and the tiling breakpoints.
//
// Activity is steerable at runtime: type commands at the prompt to flip a user
// between active and idle, add users, or drop them. That matters because a
// queue only forms when the room is full AND occupants have gone quiet, which
// is impossible to stage with static flags.
//
// Run this against your OWN local dev server only - never a shared/remote
// one. The env overrides below deliberately weaken real anti-abuse limits,
// and this spins up real bot connections into a real room.
//
// The server caps sockets per IP well below a room's capacity, so simulating a
// full room needs both overrides on the server side:
//
//   IDLE_THRESHOLD_MS=15000 MAX_CONNECTIONS_PER_IP=40 npm start
//   node tools/simulate-users.js --count 12 --room 000001
//
// Via npm, args need the `--` separator or npm swallows them itself:
//   npm run simulate -- --count 12 --room 000001
//
// Commands: list | idle <n|all> | active <n|all> | add [k] | drop <n> | quit

const { io } = require("socket.io-client");
const readline = require("readline");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const SERVER = opt("server", "http://localhost:3000");
const ROOM_ID = opt("room", null);
const COUNT = Number(opt("count", 3));
const ACCESS_CODE = opt("access-code", null);
// How many of the initial batch start idle; the rest chatter.
const IDLE_COUNT = Number(opt("idle", 0));
const CHAT_INTERVAL_MS = Number(opt("chat-interval", 3000));

if (!ROOM_ID) {
  console.error(
    "Missing --room <roomId>. Example: node tools/simulate-users.js --room 000001\n" +
      "Via npm, remember the -- separator: npm run simulate -- --room 000001",
  );
  process.exit(1);
}

// One token, many sockets. Token requests are capped at 3/hour and 3 active
// per IP, but nothing limits how many connections reuse a single token - so
// asking for one per simulated user makes 10 users impossible locally.
async function requestToken() {
  let res;
  try {
    res = await fetch(`${SERVER}/api/v1/bot-tokens/request`, {
      method: "POST",
    });
  } catch (err) {
    // Node's fetch collapses every network failure to the unhelpful message
    // "fetch failed" and buries the real reason in err.cause.
    throw new Error(
      `Could not reach ${SERVER} (${err.cause?.code || err.cause?.message || err.message}). ` +
        `Is the server running? Start it in another terminal:\n` +
        `  IDLE_THRESHOLD_MS=15000 MAX_CONNECTIONS_PER_IP=40 npm start`,
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

const users = [];

function spawn(token, index) {
  const name = `Sim${String(index).padStart(2, "0")}`;
  const socket = io(SERVER, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
  });

  const user = {
    index,
    name,
    socket,
    active: false,
    state: "connecting",
    timer: null,
    tick: 0,
  };

  socket.on("connect", () => {
    socket.emit("join lobby", { username: name, location: "Harness" });
  });

  socket.on("signin status", (data) => {
    if (!data?.isSignedIn) return;
    user.userId = data.userId;
    const payload = { roomId: ROOM_ID };
    if (ACCESS_CODE) payload.accessCode = ACCESS_CODE;
    socket.emit("join room", payload);
  });

  socket.on("room joined", () => {
    user.state = "in-room";
    log(user, "joined the room");
  });

  socket.on("room queued", (data) => {
    user.state = `queued#${data?.position ?? "?"}`;
    log(user, `queued at position ${data?.position ?? "?"}`);
  });

  socket.on("room capacity evicted", (data) => {
    user.state = "evicted";
    log(user, `yielded its seat in ${data?.roomName ?? ROOM_ID}`);
  });

  socket.on("room full", () => {
    user.state = "refused";
    log(user, "refused: room full");
  });

  socket.on("room closed", (data) => {
    user.state = "room-closed";
    log(user, `room closed: ${data?.message ?? ""}`);
  });

  socket.on("kicked", () => {
    user.state = "kicked";
    log(user, "voted out");
  });

  socket.on("error", (err) => {
    log(user, `error: ${err?.error?.message ?? JSON.stringify(err)}`);
  });

  socket.on("validation_error", (err) => {
    log(user, `validation error: ${JSON.stringify(err)}`);
  });

  socket.on("connect_error", (err) => {
    user.state = "connect-failed";
    log(user, `connect failed: ${err.message}`);
    if (/Too many connections/i.test(err.message)) {
      log(
        user,
        "raise MAX_CONNECTIONS_PER_IP on the server to simulate a full room",
      );
    }
  });

  socket.on("disconnect", (reason) => {
    user.state = "disconnected";
    log(user, `disconnected (${reason})`);
    stopActivity(user);
  });

  users.push(user);
  return user;
}

function log(user, message) {
  process.stdout.write(`\r[${user.name}] ${message}\n`);
  rl?.prompt(true);
}

// An "active" user types continuously, which is what refreshes its activity
// timestamp server-side. Idle users stay connected and simply say nothing.
function startActivity(user) {
  if (user.timer) return;
  user.active = true;
  user.timer = setInterval(() => {
    if (!user.socket.connected) return;
    user.tick += 1;
    user.socket.emit("chat update", {
      diff: { type: "full-replace", text: `${user.name} still here #${user.tick}` },
    });
  }, CHAT_INTERVAL_MS);
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

function printList() {
  console.log("\n  #   name     activity  state");
  for (const u of users) {
    console.log(
      `  ${String(u.index).padEnd(3)} ${u.name.padEnd(8)} ` +
        `${(u.active ? "active" : "idle").padEnd(9)} ${u.state}`,
    );
  }
  console.log();
}

let rl;

(async () => {
  const token = opt("token", null) || (await requestToken());
  console.log(`Server: ${SERVER}`);
  console.log(`Room:   ${ROOM_ID}`);
  console.log(`Spawning ${COUNT} users (${IDLE_COUNT} idle)...\n`);

  for (let i = 1; i <= COUNT; i++) {
    const user = spawn(token, i);
    if (i > IDLE_COUNT) startActivity(user);
    // Stagger so join order (and therefore "longest present") is deterministic.
    await new Promise((r) => setTimeout(r, 250));
  }

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  console.log(
    "\nCommands: list | idle <n|all> | active <n|all> | add [k] | drop <n> | quit\n",
  );
  rl.prompt();

  rl.on("line", async (line) => {
    const [cmd, arg] = line.trim().split(/\s+/);
    switch (cmd) {
      case "list":
        printList();
        break;
      case "idle":
        pick(arg).forEach((u) => {
          stopActivity(u);
          log(u, "now idle");
        });
        break;
      case "active":
        pick(arg).forEach((u) => {
          startActivity(u);
          log(u, "now active");
        });
        break;
      case "add": {
        const k = Number(arg) || 1;
        for (let i = 0; i < k; i++) {
          const user = spawn(token, users.length + 1);
          startActivity(user);
          await new Promise((r) => setTimeout(r, 250));
        }
        break;
      }
      case "drop":
        pick(arg).forEach((u) => {
          stopActivity(u);
          u.socket.disconnect();
        });
        break;
      case "quit":
      case "exit":
        shutdown();
        return;
      case "":
        break;
      default:
        console.log(`Unknown command: ${cmd}`);
    }
    rl.prompt();
  });

  rl.on("close", shutdown);
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

function shutdown() {
  console.log("\nDisconnecting...");
  for (const u of users) {
    stopActivity(u);
    if (u.socket.connected) {
      u.socket.emit("leave room");
      u.socket.disconnect();
    }
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
