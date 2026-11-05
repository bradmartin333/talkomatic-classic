---
name: run-talkomatic-classic
description: Run, start, launch, screenshot or test talkomatic-classic in a real browser. Starts an isolated dev server and drives room.html as one or more users (emulated phone and/or desktop) to type, tap, read other users' boxes and take screenshots. Use to verify chat UI changes end to end.
---

# Run talkomatic-classic

Talkomatic is an Express + socket.io server (`server.js`) serving the live
chat page `room.html` (`/` redirects there). Agents drive it with two files in
this directory: `serve.sh` starts an isolated server, and `driver.cjs` runs
headless Chrome as several users at once, reading commands from stdin.

All paths are relative to the repo root (or the worktree root). Verified on
macOS with Google Chrome installed.

## Setup (once per machine)

The driver needs `playwright-core`. It lives outside the repo, so
`package.json` stays untouched. It launches the installed Google Chrome
(`channel: "chrome"`), so no browser download is needed.

```bash
npm install --silent --prefix "${TMPDIR:-/tmp}/tk-pw" playwright-core@1.48.2
```

## Run (agent path)

```bash
.claude/skills/run-talkomatic-classic/serve.sh start        # port 3123
```

This frees the port, starts `server.js` in the background with a throwaway
`DATA_DIR` (`$TMPDIR/tk-run-3123/`, log in `server.log` there), and makes sure
the login account `tester`/`testpw` exists. It never touches the repo's own
`.env`, `rooms.json` or `accounts.json`. Run it again to restart with fresh
rooms.

Then pipe a script to the driver:

```bash
node .claude/skills/run-talkomatic-classic/driver.cjs <<'EOF'
open phoneuser phone
open deskuser desktop
type phoneuser hello from the phone,
type phoneuser  dictated in two phrases
wait 600
text phoneuser
peer deskuser phoneuser
ss phoneuser phone-typed
tap phoneuser .chat-row.current-user .chat-clear-button
wait 600
peer deskuser phoneuser
ss deskuser desk
quit
EOF
```

Commands (`<id>` is both the handle and the display name the user joins as):

| Command | Does |
|---|---|
| `open <id> phone\|desktop [path]` | New browser context (iPhone 390x844 with touch, or 1280x800), logs in, joins `path` (default `/room.html`) |
| `type <id> <text>` | Inserts text into `<id>`'s own box as a single input event (one dictation phrase). Text is verbatim after the one space following `<id>`, and lines are not space-joined, so start a follow-on phrase with an extra space |
| `tap <id> <selector>` / `click <id> <selector>` | Touch tap / mouse click |
| `text <id> [selector]` | Prints textContent (default: own box) |
| `peer <id> <name>` | Prints what `<id>` sees in `<name>`'s box, which shows the change reached other users |
| `eval <id> <js>` | Prints the result of a JS expression in the page |
| `ss <id> [name]` | Screenshot to `$TMPDIR/tk-run-shots/<name>.png` (override with `TK_OUT`). Open and look at it |
| `wait <ms>` / `quit` | |

The driver echoes each command, prints `ERROR:` lines without stopping, and
reports page errors, `console.error` output and any open error modal
(`MODAL OPEN: ...`) after each step. For an interactive session, run it under
tmux and `send-keys` one line at a time.

Useful selectors: own box `.chat-row.current-user .chat-input`, a user's row
`.chat-row[data-user-id=...]`, name label `.ui-name`, room error modal
`#customModal.show`.

Stop:

```bash
.claude/skills/run-talkomatic-classic/serve.sh stop
```

## Run (human path)

`./dev-start.sh` serves on :3000 using the repo's `.env` (it creates one with a
fresh `SESSION_SECRET` if missing) and writes room and account state into the
repo root. Accounts come from `npm run ops -- adduser <name> <pw>` while it
runs. Agents should use `serve.sh` instead.

## Gotchas

- **The login form can't be submitted from the page.** `/login` sends
  `Referrer-Policy: no-referrer`, so Chrome posts the form with `Origin: null`,
  and the CORS check in `server.js` answers `Error: CORS blocked` (a raw stack
  trace page). The driver logs in with `context.request.post('/login')`
  instead, which sends no Origin and shares the page's cookie jar.
- **Any port other than 3000 needs `ALLOWED_ORIGINS=http://localhost:<port>`**,
  or every POST is CORS-blocked. `serve.sh` sets it.
- **Typing fast trips the server's rate limit** (75 socket events per second,
  `SOCKET_MAX_REQUESTS_PER_WINDOW` in `server/state.js`). Playwright's
  `keyboard.type` sends one event per character, so a sentence brings up an
  "Error: Rate limit exceeded." modal. That modal then silently absorbs every
  later tap. Use the driver's `type`, which inserts a whole phrase as one
  event, and split long text over several `type` lines.
- **Reusing a display name against the same server hangs `open`.** The
  previous run's seats linger as ghosts under that name. Use new names, or
  rerun `serve.sh start` (it clears `rooms.json` too).
- **Restarting too quickly crashes the server with `EADDRINUSE`.** The old
  process takes a moment to release the port. `serve.sh` waits for it.
- **A git worktree has no `node_modules`.** `serve.sh start` symlinks the main
  checkout's copy. The symlink shows as untracked (`?? node_modules`), so delete
  it before committing.
- `adduser` talks to the running server over loopback (`/operator/accounts`),
  so it only works after the server is up. It reads `PORT` from the
  environment.
- On touch devices, own-row controls may be shown only under
  `@media (pointer: coarse)`. Chrome's `isMobile` + `hasTouch` emulation
  matches it, and the desktop context doesn't.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `playwright-core not found in ...` | Run the Setup `npm install` (or set `TK_PW_DIR`) |
| `login failed (200)` | The account is missing or the server isn't running. Rerun `serve.sh start` |
| `join as "<id>" timed out` | That name was used earlier against this server. Pick a new one or restart |
| `MODAL OPEN: Error An error occurred: Rate limit exceeded.` | Too many events in a second. Use fewer, larger `type` lines |
| `page.goto: net::ERR_CONNECTION_REFUSED` | The server died. Check `$TMPDIR/tk-run-3123/server.log` (often `EADDRINUSE`) |
