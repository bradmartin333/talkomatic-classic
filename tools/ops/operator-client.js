// REST client for the app's own loopback-only /operator/* endpoints (see
// operatorOnly in server.js). No auth token: shell access to the host/
// container running the server IS the credential, so this only works run
// alongside a locally-reachable server.
//
// PORT is read from the environment, matching the server's own default.

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
                  "the container: docker compose exec talkomatic npm run ops ...",
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

async function listRooms() {
  const { rooms } = await request("GET", "/operator/users");
  return rooms;
}

async function kickUser(userId, roomId) {
  return request("POST", "/operator/kick", { userId, roomId });
}

async function setCapacity(capacity, roomId) {
  return request("POST", "/operator/capacity", { capacity, roomId });
}

module.exports = { listRooms, kickUser, setCapacity };
