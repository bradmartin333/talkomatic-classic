#!/usr/bin/env node
/**
 * Unified operator tool: list/kick seats, change room capacity, simulate
 * load, and hot-swap bot personas - one entry point, interactive or scripted.
 *
 * Run it inside the container, which is what authorizes the REST-backed
 * commands (list/kick/capacity) - those endpoints only answer loopback
 * connections (see operatorOnly in server.js), so shell access to the
 * container is the credential and there is no key to pass.
 *
 *   node tools/ops.js                                    interactive menu
 *   node tools/ops.js list
 *   node tools/ops.js kick <userId> [--room <roomId>]
 *   node tools/ops.js capacity <n> [--room <roomId>]
 *   node tools/ops.js simulate [--server u] [--room r] [--count n] ...
 *   node tools/ops.js bots list|status [container]|load <profile> [container]
 *
 * Via npm, put -- before any flag: npm consumes flags like --room itself and
 * forwards only their value, which the strict parsers below reject rather
 * than misreading (e.g. as an unscoped kick):
 *   npm run ops -- kick <userId> --room <roomId>
 *
 * PORT is read from the environment, matching the server's own default.
 */

const readline = require("readline");
const operatorClient = require("./ops/operator-client");
const simulateEngine = require("./ops/simulate");
const botCtl = require("./ops/bot-ctl");

// The app's own permanent, always-present room (see MAIN_ROOM_ID in
// server/rooms.js) - the sensible default whenever a room id is needed and
// none was given.
const DEFAULT_ROOM_ID = "000001";

// ── Shared readline + log() redraw helper ───────────────────────────────────
// One Interface for the whole process, so async output (socket events, bot
// personas) never clobbers whatever prompt happens to be showing. ask() is
// the single way anything in this tool reads a line: it sets the visible
// prompt via setPrompt (so log()'s redraw always matches it) then resolves on
// the next line via a one-shot listener.

let rl = null;
let lineIterator = null;
function ensureRl() {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // readline.Interface's async iterator queues 'line' events internally, so
    // input that arrives in a burst (piped/scripted stdin, or a paste of
    // several lines) is never dropped between one ask() resolving and the
    // next one re-arming - unlike a fresh rl.once("line", ...) each call,
    // which can miss a line emitted before the new listener attaches.
    lineIterator = rl[Symbol.asyncIterator]();
  }
  return rl;
}

// Resolves to the next line, or null if stdin closed (EOF) - callers treat
// that the same as an explicit quit. With piped/scripted stdin, the
// interface can auto-close as soon as the underlying stream drains, even
// while the async iterator still has queued lines left to yield - so
// prompt() (a pure display nicety, meaningless once closed anyway) is
// best-effort, and the queued line is still delivered regardless.
async function ask(promptText) {
  ensureRl();
  try {
    rl.setPrompt(promptText);
    rl.prompt();
  } catch (_) {
    // already closed
  }
  const { value, done } = await lineIterator.next();
  return done ? null : value.trim();
}

function log(message) {
  process.stdout.write(`\r${message}\n`);
  try {
    if (rl) rl.prompt(true);
  } catch (_) {
    // already closed
  }
}

// ── Formatting (ported from the old admin.js) ───────────────────────────────

function ago(ts) {
  if (!ts) return "";
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3600)}h`;
}

function printRoomList(rooms) {
  if (!rooms.length) return console.log("No rooms.");
  let seats = 0;
  let ghosts = 0;
  for (const room of rooms) {
    const shown = room.users || [];
    console.log(
      `\n${room.roomName || "(unnamed)"}  [room ${room.roomId}]  ` +
        `${shown.length}/${room.capacity}`,
    );
    if (!shown.length) {
      console.log("  (empty)");
      continue;
    }
    // Names repeat across ghost/live pairs, so the id column is the one that
    // actually identifies a row - keep it unabridged and easy to copy.
    for (const u of shown) {
      seats++;
      if (u.ghost) ghosts++;
      const state = u.ghost
        ? `GHOST  left ${ago(u.departedAt)} ago`
        : u.live
          ? "live"
          : "no socket";
      const tags = [u.isBot ? "bot" : null].filter(Boolean).join(" ");
      console.log(
        `  ${u.id}  ${(u.username || "(no name)").padEnd(20)} ${state}${tags ? "  " + tags : ""}`,
      );
    }
  }
  console.log(`\n${seats} seat(s), ${ghosts} ghost(s).`);
}

function printKickResult(userId, result) {
  if (!result.seats.length && !result.disconnected) {
    console.log(`No seat or socket found for ${userId}. Nothing to do.`);
    return;
  }
  for (const seat of result.seats) {
    console.log(
      `Removed ${seat.wasGhost ? "ghost" : "user"} ${seat.username} (${userId}) ` +
        `from ${seat.roomName || seat.roomId}`,
    );
  }
  if (result.disconnected) {
    console.log(`Disconnected ${result.disconnected} live socket(s) for that id.`);
  }
}

function printCapacityResult(result) {
  if (result.scope === "room") {
    console.log(`${result.roomName || result.roomId} capacity set to ${result.capacity}.`);
  } else {
    console.log(
      `Global default room capacity set to ${result.capacity}. This is in memory ` +
        "only and resets to the server's built-in default when it restarts.",
    );
  }
  for (const seat of result.evicted || []) {
    console.log(
      `  kicked ${seat.wasGhost ? "ghost" : "user"} ${seat.username} ` +
        `from ${seat.roomName || seat.roomId} (over new capacity, most recently joined first)`,
    );
  }
}

// ── list / kick / capacity: shared by non-interactive and menu paths ───────

async function doList() {
  printRoomList(await operatorClient.listRooms());
}

async function doKick(userId, roomId) {
  printKickResult(userId, await operatorClient.kickUser(userId, roomId));
}

async function doCapacity(capacity, roomId) {
  printCapacityResult(await operatorClient.setCapacity(capacity, roomId));
}

// Strict on purpose. `npm run ops kick <id> --room <rid>` does NOT reach us
// intact: npm consumes --room as one of its own options and forwards only its
// value, as a bare positional. Parsed loosely, that silently becomes an
// unscoped kick - the flag meant to NARROW the blast radius quietly widens it
// to every room. So an unexpected positional is an error, not something to
// shrug off, and the message points at the -- separator that fixes it.
function parseRoomScopedArgs(rest, { requirePositional, label }) {
  const positional = [];
  let roomId = null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--room") {
      roomId = rest[++i] || null;
      if (!roomId) return { error: "--room needs a room id." };
      continue;
    }
    if (arg.startsWith("--room=")) {
      roomId = arg.slice("--room=".length) || null;
      if (!roomId) return { error: "--room needs a room id." };
      continue;
    }
    if (arg.startsWith("--")) return { error: `Unknown option ${arg}.` };
    positional.push(arg);
  }
  if (requirePositional && positional.length === 0) {
    return { error: `${label} needs a value.` };
  }
  if (positional.length > 1) {
    return {
      error:
        `Expected one value, got ${positional.length}: ${positional.join(", ")}\n` +
        "If you ran this through npm, put -- before the arguments so npm\n" +
        "forwards flags instead of swallowing them:\n" +
        `  npm run ops -- ${label} <value> --room <roomId>`,
    };
  }
  return { value: positional[0] || null, roomId };
}

// ── bots ─────────────────────────────────────────────────────────────────

function printBotCtlResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (!result.ok) {
    // result.error is just result.stderr.trim() when stderr was set (see
    // bot-ctl.js) - only fall back to printing it when stderr was empty
    // (script not found, failed to spawn, or exited with no output), so a
    // failure isn't shown twice.
    if (!result.stderr) console.error(result.error);
    process.exitCode = 1;
  }
}

// Every current bot seat, across every room, regardless of which container
// holds it - the operator API has no way to tell one bot container's seat
// from another's, so this is the only granularity available.
async function kickAllBots() {
  const rooms = await operatorClient.listRooms();
  const seats = [];
  for (const room of rooms) {
    for (const u of room.users || []) {
      if (u.isBot) seats.push({ roomId: room.roomId, roomName: room.roomName, userId: u.id, username: u.username });
    }
  }
  for (const seat of seats) {
    await operatorClient.kickUser(seat.userId, seat.roomId);
  }
  return seats;
}

// Loading a persona (bots load) hot-swaps the config and SIGHUPs the
// container, but that changes what the bot SAYS, not the socket/seat it
// already holds - a bot mid-room keeps its old username and identity until
// something makes it reconnect. Kicking every bot seat right after a
// successful load is that something: only one persona should ever be
// speaking at a time, so every existing bot seat is stale the moment a new
// one loads, and forcing the reconnect is what actually surfaces the swap.
async function loadBotPersona(profile, container) {
  const result = botCtl.load(profile, container);
  printBotCtlResult(result);
  if (!result.ok) return;
  try {
    const kicked = await kickAllBots();
    if (kicked.length) {
      console.log(`Kicked ${kicked.length} existing bot seat(s) so they reconnect under the new persona:`);
      for (const seat of kicked) console.log(`  ${seat.username} from ${seat.roomName || seat.roomId}`);
    }
  } catch (e) {
    console.error(`Persona loaded, but could not kick existing bot seats: ${String(e.message || e)}`);
  }
}

async function doBots(rest) {
  const [sub, ...args] = rest;
  if (sub === "list") return printBotCtlResult(botCtl.list());
  if (sub === "status") return printBotCtlResult(botCtl.status(args[0]));
  if (sub === "load") {
    if (!args[0]) {
      console.error("bots load needs a profile name.");
      process.exitCode = 1;
      return;
    }
    return loadBotPersona(args[0], args[1]);
  }
  console.error("Usage: node tools/ops.js bots list|status [container]|load <profile> [container]");
  process.exitCode = 1;
}

// ── simulate ─────────────────────────────────────────────────────────────

function optFrom(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

async function runSimulateRepl(session, token) {
  console.log(
    "\nCommands: list | idle <n|all> | active <n|all> | add [k] | drop <n> | back | quit\n",
  );
  for (;;) {
    const line = await ask("> ");
    if (line === null) {
      console.log("\nDisconnecting...");
      session.shutdown();
      return "quit";
    }
    const [cmd, arg] = line.split(/\s+/);
    if (cmd === "list") {
      console.log(`\n${session.listText()}\n`);
    } else if (cmd === "idle") {
      session.setActive(arg, false);
    } else if (cmd === "active") {
      session.setActive(arg, true);
    } else if (cmd === "add") {
      await session.add(token, Number(arg) || 1);
    } else if (cmd === "drop") {
      session.drop(arg);
    } else if (cmd === "back") {
      console.log("Leaving simulate mode; simulated users keep running in the background.");
      return "back";
    } else if (cmd === "quit" || cmd === "exit") {
      console.log("\nDisconnecting...");
      session.shutdown();
      return "quit";
    } else if (cmd) {
      console.log(`Unknown command: ${cmd}`);
    }
  }
}

async function startSimulate(opts) {
  const { server, roomId, accessCode, asBot, chatIntervalMs, count, idleCount, token: presetToken } = opts;
  const token = asBot ? presetToken || (await simulateEngine.requestToken(server)) : null;
  console.log(`Server: ${server}`);
  console.log(`Room:   ${roomId}`);
  console.log(
    `Mode:   ${asBot ? "bots (bot-token, exempt from idle-eviction)" : "humans (spoofed browser, evictable)"}`,
  );
  console.log(`Spawning ${count} users (${idleCount} idle)...\n`);

  const session = simulateEngine.createSession({ server, roomId, accessCode, asBot, chatIntervalMs, log });
  await session.spawnBatch(token, count, idleCount);
  const outcome = await runSimulateRepl(session, token);
  return outcome;
}

async function doSimulate(rest) {
  const roomId = optFrom(rest, "room", DEFAULT_ROOM_ID);
  await startSimulate({
    server: optFrom(rest, "server", "http://localhost:3000"),
    roomId,
    accessCode: optFrom(rest, "access-code", null),
    asBot: rest.includes("--as-bot"),
    chatIntervalMs: Number(optFrom(rest, "chat-interval", 3000)),
    count: Number(optFrom(rest, "count", 3)),
    idleCount: Number(optFrom(rest, "idle", 0)),
    token: optFrom(rest, "token", null),
  });
  process.exit(0);
}

// ── Interactive menu ─────────────────────────────────────────────────────

function flattenSeats(rooms) {
  const seats = [];
  for (const room of rooms) {
    for (const u of room.users || []) {
      seats.push({
        roomId: room.roomId,
        roomName: room.roomName,
        userId: u.id,
        username: u.username,
        ghost: u.ghost,
        live: u.live,
        isBot: u.isBot,
        departedAt: u.departedAt,
      });
    }
  }
  return seats;
}

// Selecting from a live list instead of retyping/copying a user id also
// resolves the room automatically, so there is no separate "which room?"
// prompt (and no way to accidentally widen a kick to every room, unlike the
// --room-scoped non-interactive form).
async function menuKick() {
  const seats = flattenSeats(await operatorClient.listRooms());
  if (!seats.length) {
    console.log("No seats to kick.");
    return;
  }
  console.log();
  seats.forEach((s, i) => {
    const state = s.ghost
      ? `GHOST  left ${ago(s.departedAt)} ago`
      : s.live
        ? "live"
        : "no socket";
    const tags = s.isBot ? " bot" : "";
    console.log(
      `  ${String(i + 1).padStart(2)}) ${(s.username || "(no name)").padEnd(20)} ${state}${tags}  [${s.roomName || s.roomId}]`,
    );
  });
  const choice = await ask("\nkick which #? (blank to cancel): ");
  if (!choice) return;
  const seat = seats[Number(choice) - 1];
  if (!seat) {
    console.log("No such selection.");
    return;
  }
  const confirm = await ask(`kick ${seat.username} from ${seat.roomName || seat.roomId}? [y/N]: `);
  if (!/^y/i.test(confirm)) {
    console.log("Cancelled.");
    return;
  }
  try {
    await doKick(seat.userId, seat.roomId);
  } catch (e) {
    console.error(String(e.message || e));
  }
}

async function menuCapacity() {
  const rooms = await operatorClient.listRooms();
  console.log("\n   0) Global default");
  rooms.forEach((r, i) => {
    console.log(
      `  ${String(i + 1).padStart(2)}) ${r.roomName || "(unnamed)"}  ${(r.users || []).length}/${r.capacity}  [${r.roomId}]`,
    );
  });
  const choice = await ask("\nwhich? [0]: ");
  const room = choice ? rooms[Number(choice) - 1] : null;
  if (choice && !room) {
    console.log("No such selection.");
    return;
  }
  const capacity = await ask("new capacity: ");
  try {
    await doCapacity(capacity, room ? room.roomId : null);
  } catch (e) {
    console.error(String(e.message || e));
  }
}

async function menuSimulate() {
  const roomId = (await ask(`room id [${DEFAULT_ROOM_ID}]: `)) || DEFAULT_ROOM_ID;
  const count = Number(await ask("how many users? [3]: ")) || 3;
  const idleCount = Number(await ask("how many start idle? [0]: ")) || 0;
  const asBot = /^y/i.test(await ask("connect as bots (exempt from idle-eviction)? [y/N]: "));
  try {
    await startSimulate({
      server: `http://localhost:${process.env.PORT || 3000}`,
      roomId,
      accessCode: null,
      asBot,
      chatIntervalMs: 3000,
      count,
      idleCount,
      token: null,
    });
  } catch (e) {
    console.error(String(e.message || e));
  }
}

async function menuBots() {
  for (;;) {
    console.log("\nBot personas\n  1) list\n  2) status\n  3) load\n  4) back\n");
    const choice = await ask("select> ");
    if (choice === null) return;
    if (choice === "1") {
      printBotCtlResult(botCtl.list());
    } else if (choice === "2") {
      const container = (await ask("container (blank = default): ")) || undefined;
      printBotCtlResult(botCtl.status(container));
    } else if (choice === "3") {
      const profile = await ask("profile: ");
      if (!profile) continue;
      const container = (await ask("container (blank = default): ")) || undefined;
      await loadBotPersona(profile, container);
    } else if (choice === "4" || /^b/i.test(choice)) {
      return;
    } else {
      console.log(`Unknown option: ${choice}`);
    }
  }
}

function printHelp() {
  console.log(
    [
      "Talkomatic Ops",
      "",
      "  1) List rooms & users",
      "  2) Kick a user",
      "  3) Set room capacity",
      "  4) Simulate users",
      "  5) Bot personas",
      "  6) Help",
      "  0) Quit",
    ].join("\n"),
  );
}

async function interactiveMenu() {
  ensureRl();
  for (;;) {
    printHelp();
    const choice = await ask("\n> ");
    if (choice === null || choice === "0" || /^q/i.test(choice)) {
      rl.close();
      process.exit(0);
    }
    try {
      if (choice === "1") await doList();
      else if (choice === "2") await menuKick();
      else if (choice === "3") await menuCapacity();
      else if (choice === "4") await menuSimulate();
      else if (choice === "5") await menuBots();
      else if (choice === "6") printHelp();
      else console.log(`Unknown option: ${choice}`);
    } catch (e) {
      console.error(String(e.message || e));
    }
  }
}

// ── Entry point ──────────────────────────────────────────────────────────

function usage() {
  console.log(
    [
      "Usage:",
      "  node tools/ops.js                                    interactive menu",
      "  node tools/ops.js list",
      "  node tools/ops.js kick <userId> [--room <roomId>]",
      "  node tools/ops.js capacity <n> [--room <roomId>]",
      "  node tools/ops.js simulate [--server u] [--room r] [--count n] [--idle n]",
      "                             [--access-code c] [--chat-interval ms] [--as-bot] [--token t]",
      "  node tools/ops.js bots list|status [container]|load <profile> [container]",
      "",
      "  The -- is required through npm whenever you pass a flag: without it npm",
      "  keeps the flag for itself and the tool never sees it, e.g.:",
      "    npm run ops -- kick <userId> --room <roomId>",
    ].join("\n"),
  );
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd) return interactiveMenu();

  if (cmd === "list") return doList();

  if (cmd === "kick") {
    const { value: userId, roomId, error } = parseRoomScopedArgs(rest, {
      requirePositional: true,
      label: "kick",
    });
    if (error) {
      console.error(error + "\n");
      usage();
      process.exitCode = 1;
      return;
    }
    return doKick(userId, roomId);
  }

  if (cmd === "capacity") {
    const { value: capacity, roomId, error } = parseRoomScopedArgs(rest, {
      requirePositional: true,
      label: "capacity",
    });
    if (error) {
      console.error(error + "\n");
      usage();
      process.exitCode = 1;
      return;
    }
    return doCapacity(capacity, roomId);
  }

  if (cmd === "simulate") return doSimulate(rest);
  if (cmd === "bots") return doBots(rest);

  usage();
  process.exitCode = 1;
}

process.on("SIGINT", () => {
  console.log("\nExiting.");
  process.exit(0);
});

main().catch((e) => {
  console.error(String(e.message || e));
  process.exitCode = 1;
});
