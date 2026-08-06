#!/usr/bin/env bash
# Local dev server for manual testing. Not part of deployment - the Docker
# image and Dokploy use their own env vars (see .env.example).
#
# Usage: ./dev-start.sh [port]

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

PORT="${1:-3000}"

if [ ! -f .env ]; then
  echo "No .env found - creating one with a fresh SESSION_SECRET."
  echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env
fi

if [ ! -d node_modules ]; then
  npm install
fi

# PORT here overrides whatever is in .env, without touching the file.
echo "Starting Talkomatic on http://localhost:${PORT}"
PORT="$PORT" node server.js
