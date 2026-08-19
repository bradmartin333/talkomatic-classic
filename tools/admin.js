#!/usr/bin/env node
/**
 * Operator CLI: list occupied seats and kick one by user id.
 *
 * Run it inside the container, which is what authorizes it - the endpoints it
 * calls only answer loopback connections (see operatorOnly in server.js), so
 * shell access to the container is the credential and there is no key to pass.
 *
 *   docker compose exec talkomatic node tools/admin.js list
 *   docker compose exec talkomatic node tools/admin.js kick <userId>
 *   docker compose exec talkomatic node tools/admin.js kick <userId> --room <roomId>
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
                  "the container: docker compose exec talkomatic node tools/admin.js ...",
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
      `Kick one with: node tools/admin.js kick <id>`,
  );
}

async function kick(userId, roomId) {
  const result = await request("POST", "/operator/kick", { userId, roomId });
  if (!result.seats.length && !result.disconnected) {
    console.log(`No seat or socket found for ${userId}. Nothing to do.`);
    console.log("Run `list` to see current ids.");
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
      "  node tools/admin.js list",
      "  node tools/admin.js kick <userId> [--room <roomId>]",
      "",
      "  list   show every occupied seat with its user id, marking ghosts",
      "  kick   free a seat by id; ghosts are evicted, live users disconnected",
    ].join("\n"),
  );
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "list") return list();
  if (cmd === "kick") {
    const userId = rest.find((a) => !a.startsWith("--"));
    if (!userId) {
      usage();
      process.exitCode = 1;
      return;
    }
    const roomFlag = rest.indexOf("--room");
    const roomId = roomFlag !== -1 ? rest[roomFlag + 1] : null;
    return kick(userId, roomId);
  }
  usage();
  if (cmd) process.exitCode = 1;
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exitCode = 1;
});
