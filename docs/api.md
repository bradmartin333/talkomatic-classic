# Talkomatic Classic API

Base URL: `https://classic.talkomatic.co` (or `http://localhost:3000` when self-hosting).
All REST endpoints live under `/api/v1`. Responses are JSON.

Most of Talkomatic runs over Socket.IO, not REST. The REST surface covers
monitoring, bot access, and room discovery; everything real-time (chat,
typing, rooms, games) happens on the socket connection.

## Monitoring endpoints

These three endpoints are public, need no headers or tokens, and are exempt
from the bot filter, so uptime monitors such as Uptime Kuma can poll them
directly.

### GET /healthz

Liveness probe. Answers as long as the process is up. This is what the Docker
`HEALTHCHECK` uses.

```json
{ "status": "ok", "uptime": 12345.6 }
```

### GET /api/v1/health

Detailed health for monitoring. `status` is `"ok"` only when every subsystem
is up, and `"degraded"` otherwise, so a keyword monitor on `"status":"ok"`
catches partial failures too.

```json
{
  "status": "ok",
  "timestamp": 1753822800000,
  "uptimeSeconds": 86400,
  "version": { "server": "2.3.0", "api": "v1", "protocol": 1 },
  "process": { "node": "v22.15.0", "heapUsedMB": 42, "rssMB": 180 },
  "rooms": { "active": 3, "limit": 15 },
  "users": { "inRooms": 7, "sockets": 22 },
  "subsystems": { "socketio": "ok", "imageSafetyScanner": "ok" }
}
```

Suggested Uptime Kuma setup:

| Monitor | Type | Target | Check |
| --- | --- | --- | --- |
| Process up | HTTP(s) | `/healthz` | status code 200 |
| Full health | HTTP(s) - keyword | `/api/v1/health` | keyword `"status":"ok"` |
| Public status | HTTP(s) - keyword | `/api/v1/status` | keyword `"status":"online"` |

### GET /api/v1/status

Small public summary, safe to show on a status page.

```json
{
  "status": "online",
  "name": "Talkomatic Classic",
  "version": "2.3.0",
  "uptimeSeconds": 86400,
  "usersOnline": 22,
  "usersInRooms": 7,
  "activeRooms": 3
}
```

## Bot access

Browser visitors connect without any token. Anything that is not a browser
(scripts, bots) must request a bot token first, then present it on both REST
calls and the socket connection.

### 1. Request a token

```
POST /api/v1/bot-tokens/request
```

No body is needed. The request must NOT come from a browser (browsers never
need tokens). The response:

```json
{
  "token": "...",
  "expiresIn": 86400000,
  "expiresAt": "2026-07-30T00:00:00.000Z",
  "usage": { "rateLimit": "60 req/min", "headers": "Authorization: Bearer {token}" }
}
```

Tokens are rate limited and capped per IP; store the token and reuse it until
it expires.

### 2. Use the token

REST: send it as a bearer header.

```
GET /api/v1/rooms
Authorization: Bearer <token>
```

Socket.IO: pass it in the handshake auth.

```js
const socket = io("https://classic.talkomatic.co", {
  auth: { token: "<token>" },
});
```

`GET /api/v1/bot-tokens/info` returns documentation about the token scheme.

## Rooms (REST)

These endpoints require either a browser session or a bot token.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/v1/config` | Server limits, feature flags, versions, room stats |
| GET | `/api/v1/rooms` | List public and semi-private rooms with users |
| GET | `/api/v1/rooms/:id` | One room's details |
| POST | `/api/v1/rooms` | Create a room (`name`, `type`, `layout`, `accessCode`) |
| POST | `/api/v1/rooms/:id/join` | Validate access (semi-private code); then join over the socket |
| GET | `/api/v1/me` | Who the current session is signed in as |

## Signing in over the socket

After connecting, announce an identity. This is also where the optional
Discord avatar goes:

```js
socket.emit("join lobby", {
  username: "MyBot",
  location: "The Cloud",
  // Optional Discord avatar. Send the Discord user id (17-20 digits) and the
  // avatar hash from Discord's CDN. Get both from one call to
  // https://pfpgrab.com/api/v1/users/<discord-id> (fields id and avatar.hash).
  // Send avatar: null (or omit it) to clear a previously set one.
  avatar: {
    discordId: "159985870458322944",
    hash: "765030df32975c5b23f8dfe86d6ff520",
    animated: false,
  },
});
```

The server validates the id and hash format and never accepts image URLs, so
avatars cannot be spoofed to arbitrary images. The avatar then shows next to
the name in the lobby list, in rooms, and on the suggestion board.

Wait for the `signin status` event, then join a room:

```js
socket.on("signin status", (d) => {
  if (d.isSignedIn) socket.emit("join room", { roomId: "123456" });
});
```

Key socket events: `join lobby`, `join room`, `chat update` (typing),
`room joined`, `room update`, `user joined`, `user left`, `lobby update`.
See the in-app documentation page for the full bot guide with examples.

## Rate limits

- HTTP: 100 requests per 15 minutes per IP (static assets and the monitoring
  endpoints above do not count).
- Socket events: 75 per second per connection; the real-time streams
  (typing, piano) are exempt.
- Bot sockets get their own, stricter budget.
