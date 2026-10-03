#!/usr/bin/env bash
#
# Days on Draw's clock — reports, the leads page's revenue card and the date
# helpers — against a throwaway mongod (scripts/drawDates.e2e.test.ts).
#
# Nothing here reads a .env: backend/.env names the LIVE draw_crm database, and
# src/index.ts loads dotenv itself, so `bun --no-env-file` alone would not keep
# it out — DOTENV_CONFIG_PATH points at a file that does not exist as well, and
# the test refuses anything but a scratch database on 127.0.0.1.
#
#   ./scripts/draw-dates-e2e.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_PORT="${E2E_MONGO_PORT:-27098}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/draw-dates-e2e.XXXXXX")"

release_port() {
  local port="$1" pids
  for _ in $(seq 1 20); do
    pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [ -z "$pids" ] && return 0
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.25
  done
}

cleanup() {
  local code=$?
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

if lsof -nP -iTCP:"$MONGO_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port $MONGO_PORT is already in use. Set E2E_MONGO_PORT." >&2
  exit 1
fi

mkdir -p "$WORK/db"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/mongo.log" >/dev/null

export DOTENV_CONFIG_PATH="$WORK/no-such-dotenv"
export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/draw_dates_e2e"
export NODE_ENV=test
export JWT_SECRET="draw-dates-e2e-access-secret-0123456789"
export JWT_REFRESH_SECRET="draw-dates-e2e-refresh-secret-0123456789"
VAPID="$(cd "$HERE" && bun --no-env-file -e 'const k = require("web-push").generateVAPIDKeys(); console.log(k.publicKey + " " + k.privateKey)')"
export VAPID_PUBLIC_KEY="${VAPID%% *}" VAPID_PRIVATE_KEY="${VAPID##* }"

cd "$HERE"
bun --no-env-file test ./scripts/drawDates.e2e.test.ts
