#!/usr/bin/env bash
# Start/stop an isolated talkomatic dev server for agent testing.
#
#   .claude/skills/run-talkomatic-classic/serve.sh start [port]   (default 3123)
#   .claude/skills/run-talkomatic-classic/serve.sh stop  [port]
#
# start: frees the port, wipes room state from the last run, launches
# server.js in the background with a throwaway DATA_DIR, waits until it
# serves, and makes sure the login account tester/testpw exists.
# Never touches the repo's own .env, rooms.json or accounts.json.
set -euo pipefail

ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
CMD="${1:-start}"
PORT="${2:-3123}"
RUN_DIR="${TK_RUN_DIR:-${TMPDIR:-/tmp}/tk-run-$PORT}"
DATA_DIR="$RUN_DIR/data"
LOG="$RUN_DIR/server.log"

stop_port() {
  local pids
  pids="$(lsof -ti:"$PORT" -sTCP:LISTEN || true)"
  [ -n "$pids" ] && kill $pids
  # The old process takes a moment to release the port; starting before it
  # does crashes the new server with EADDRINUSE.
  for _ in $(seq 1 40); do
    lsof -ti:"$PORT" -sTCP:LISTEN >/dev/null || return 0
    sleep 0.25
  done
  echo "port $PORT still busy" >&2
  return 1
}

case "$CMD" in
  stop)
    stop_port
    echo "stopped :$PORT"
    ;;
  start)
    stop_port
    cd "$ROOT"
    # A git worktree has no node_modules of its own; borrow the main
    # checkout's. (The symlink shows as untracked - serve.sh stop doesn't
    # remove it, delete it before committing.)
    if [ ! -e node_modules ]; then
      main="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
      if [ -d "$main/node_modules" ]; then
        ln -s "$main/node_modules" node_modules
      else
        npm install
      fi
    fi
    mkdir -p "$DATA_DIR"
    # Fresh rooms each run: leftover ghosts and seats from a previous run
    # make joins hang.
    rm -f "$DATA_DIR/rooms.json"
    # ALLOWED_ORIGINS: only :3000 is allowed by default, so any other port
    # gets "CORS blocked" on every POST.
    DATA_DIR="$DATA_DIR" PORT="$PORT" SESSION_SECRET=agent-dev-secret \
      ALLOWED_ORIGINS="http://localhost:$PORT" \
      nohup node server.js >"$LOG" 2>&1 &
    for _ in $(seq 1 60); do
      curl -sf -o /dev/null "http://localhost:$PORT/login" && break
      sleep 0.5
    done
    curl -sf -o /dev/null "http://localhost:$PORT/login" || {
      tail -20 "$LOG" >&2
      exit 1
    }
    # adduser talks to the server over loopback, so it needs it running.
    PORT="$PORT" node tools/ops.js adduser tester testpw >/dev/null 2>&1 || true
    echo "talkomatic on http://localhost:$PORT  (login tester/testpw)"
    echo "log: $LOG"
    ;;
  *)
    echo "usage: $0 start|stop [port]" >&2
    exit 2
    ;;
esac
