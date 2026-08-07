<div align="center">

<img src="public/images/icons/favicon.png" alt="Talkomatic" width="90" />

# Talkomatic Classic

**The world's first chat room, reborn.** Real-time, character-by-character chat where everyone sees you type as you type, just like the original 1973 PLATO system.

[![Live Site](https://img.shields.io/website?url=https%3A%2F%2Fclassic.talkomatic.co%2Fhealthz&up_message=online&down_message=offline&label=classic.talkomatic.co)](https://classic.talkomatic.co/)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue)](license)
[![Docker Ready](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](Dockerfile)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff9800)](contributing.md)

[**Try it live**](https://classic.talkomatic.co/) · [API docs](docs/api.md) · [Report a bug](https://github.com/mohdmahmodi/talkomatic-classic/issues) · [Discord](https://discord.gg/N7tJznESrE)

</div>

---

## What is this?

Talkomatic was created in 1973 on the PLATO system at the University of Illinois. It was the first multi-user chat room ever built. This project is a faithful modern remake: no message log, no send button. Each person gets a section of the screen and everyone watches everyone else type live, letter by letter.

**This fork is a stripped-down variant for a private, invite-only deployment** (behind an edge auth layer like Cloudflare Access, so only people you've already let in can reach it). Compared to [upstream](https://github.com/mohdmahmodi/talkomatic-classic), it has no accounts, no lobby/room-list menu, and no moderation apparatus — see [Differences from upstream](#differences-from-upstream) below.

## Features

- **Live typing**: characters appear for everyone the moment you press them
- **One room**: sign in with a name and you're straight into it — no room list, no room creation
- **Discord avatars**: optionally show your Discord profile picture next to your name
- **Built-in apps**: a shared piano and a collaborative whiteboard
- **Themes**: swappable full-page themes, plus community themes
- **Bot API**: token-based access for bots, with REST and Socket.IO ([docs](docs/api.md))

## Differences from upstream

Everyone who reaches this app is already someone you've let in (at the network/auth layer), so none of upstream's trust-and-safety tooling has a job to do here. Removed: staff roles and the mod dashboard, ban appeals, the audit log, IP bans, warnings, the shared-key leak watch, moderator applications, the invite system, user reports, the suggestion board, and NSFW image scanning (which pulled in `@tensorflow/tfjs`). The lobby/room-list UI is gone too — everyone lands in the same persistent room, created automatically on first boot and exempt from the usual empty-room cleanup, so it never expires. WatchParty, the collaborative puzzle, and the mini games panel have also been removed.

The whiteboard, piano, and themes are untouched.

## Tech

Node.js, Express, and Socket.IO on the server. Vanilla JavaScript on the client with no build step and no framework. State persists to plain JSON files, so there is no database to run.

## Quick start

Requires Node.js 18 or newer.

```bash
git clone https://github.com/mohdmahmodi/talkomatic-classic.git
cd talkomatic-classic
npm install
npm start
```

Open `http://localhost:3000` and you are chatting.

## Configuration

Everything works with zero configuration. To customize, copy `.env.example` to `.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `SESSION_SECRET` | random per boot | Set this in production so sessions survive restarts |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `ALLOWED_ORIGINS` | none | Comma-separated public URLs of your instance. Required when deploying on your own domain |
| `DATA_DIR` | repo root | Where runtime JSON state is written |
| `TRUST_PROXY` | `1` | Reverse-proxy hops to trust. Set `0` if exposed directly |

## Deploying

### Docker Compose

```bash
docker compose up -d --build
```

The container listens on port 3000, binds `0.0.0.0`, and keeps all runtime state in a volume mounted at `/app/data`.

### Dokploy

1. Create an Application pointing at this repository and set the build type to **Dockerfile**.
2. Set environment variables: `SESSION_SECRET` (generate with `openssl rand -hex 32`) and `ALLOWED_ORIGINS` (the URL you will serve the app at, for example `https://chat.example.com`).
3. Add a volume mount for `/app/data` so the room and its Talkoboard/theme state survive redeploys.
4. Point your domain at container port 3000. Dokploy's Traefik proxy handles HTTPS and the server already trusts one proxy hop.

### Monitoring

The live status page for the official instance is at [status.talkomatic.co](https://status.talkomatic.co).
Three public endpoints are made for uptime monitors like Uptime Kuma:

| Endpoint | Purpose | Suggested check |
| --- | --- | --- |
| `/healthz` | Liveness | HTTP 200 |
| `/api/v1/health` | Detailed health with subsystems | keyword `"status":"ok"` |
| `/api/v1/status` | Public stats for a status page | keyword `"status":"online"` |

See the [API docs](docs/api.md) for response shapes and the bot API.

## Contributing

This is a personal fork trimmed for one private deployment, not a project taking outside contributions. For the full-featured version, see [upstream](https://github.com/mohdmahmodi/talkomatic-classic).

## License

[MIT](license)

## Credits

Built and maintained by [Mohd Mahmodi](https://mohdmahmodi.com) ([@mohdmahmodi](https://x.com/mohdmahmodi)) with the Talkomatic community. Inspired by the original Talkomatic by Doug Brown and David R. Woolley (PLATO, 1973).
