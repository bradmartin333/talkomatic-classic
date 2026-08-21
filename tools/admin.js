#!/usr/bin/env node
/**
 * Operator CLI: list occupied seats and kick one by user id.
 *
 * Run it inside the container, which is what authorizes it - the endpoints it
 * calls only answer loopback connections (see operatorOnly in server.js), so
 * shell access to the container is the credential and there is no key to pass.
 *
 *   docker compose exec talkomatic npm run admin list
 *   docker compose exec talkomatic npm run admin kick <userId>
 *   docker compose exec talkomatic npm run admin -- kick <userId> --room <roomId>
 *
 * Note the -- before any flag: npm consumes flags like --room itself and
 * forwards only their value, which parseKickArgs below rejects rather than
 * misreading as an unscoped kick. `node tools/admin.js <args>` needs no
 * separator, and is what the npm script runs.
 *
 * Seats are addressed by id, never by name: a ghost and its owner's fresh
 * session show the same username but different ids, and telling those two
 * apart is the usual reason to reach for this.
 *
 * PORT is read from the environment, matching the server's own default.
 */

const http = require("http");

const PORT = process.env.PORT || 3000;
const HOST = "127.0.0.1";

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode === 404 && !data) {
            return reject(
              new Error(
                "Endpoint refused the connection as non-local. Run this inside\n" +
                  "the container: docker compose exec talkomatic npm run admin ...",
              ),
            );
          }
          let parsed = null;
          try {
            parsed = JSON.parse(data);
          } catch (_) {
            return reject(new Error(`Unexpected reply (${res.statusCode}): ${data.slice(0, 200)}`));
          }
          if (res.statusCode >= 400) {
            return reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          }
          resolve(parsed);
        });
      },
    );
    req.on("error", (e) =>
      reject(
        new Error(
          `Could not reach the server on ${HOST}:${PORT} (${e.code || e.message}).\n` +
            "Is it running, and is PORT set the same as the server's?",
        ),
      ),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

function ago(ts) {
  if (!ts) return "";
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${Math.round(secs / 3600)}h`;
}

async function list() {
  const { rooms } = await request("GET", "/operator/users");
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
  console.log(
    `\n${seats} seat(s), ${ghosts} ghost(s). ` +
      `Kick one with: npm run admin kick <id>`,
  );
}

async function kick(userId, roomId) {
  const result = await request("POST", "/operator/kick", { userId, roomId });
  if (!result.seats.length && !result.disconnected) {
    console.log(`No seat or socket found for ${userId}. Nothing to do.`);
    console.log("Run `npm run admin list` to see current ids.");
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

function usage() {
  console.log(
    [
      "Usage (run inside the container):",
      "  npm run admin list",
      "  npm run admin kick <userId>",
      "  npm run admin -- kick <userId> --room <roomId>",
      "",
      "  The -- is required whenever you pass a flag: without it npm keeps",
      "  the flag for itself and the tool never sees it.",
      "",
      "  list   show every occupied seat with its user id, marking ghosts",
      "  kick   free a seat by id; ghosts are evicted, live users disconnected",
    ].join("\n"),
  );
}

// Strict on purpose. `npm run admin kick <id> --room <rid>` does NOT reach us
// intact: npm consumes --room as one of its own options and forwards only its
// value, as a bare positional. Parsed loosely, that silently becomes an
// unscoped kick - the flag meant to NARROW the blast radius quietly widens it
// to every room. So an unexpected positional is an error, not something to
// shrug off, and the message points at the -- separator that fixes it.
function parseKickArgs(rest) {
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
  if (positional.length === 0) return { error: "kick needs a user id." };
  if (positional.length > 1) {
    return {
      error:
        `Expected one user id, got ${positional.length}: ${positional.join(", ")}\n` +
        "If you ran this through npm, put -- before the arguments so npm\n" +
        "forwards flags instead of swallowing them:\n" +
        "  npm run admin -- kick <userId> --room <roomId>",
    };
  }
  return { userId: positional[0], roomId };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") return list();
  if (cmd === "kick") {
    const { userId, roomId, error } = parseKickArgs(rest);
    if (error) {
      console.error(error + "\n");
      usage();
      process.exitCode = 1;
      return;
    }
    return kick(userId, roomId);
  }
  usage();
  if (cmd) process.exitCode = 1;
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exitCode = 1;
});
