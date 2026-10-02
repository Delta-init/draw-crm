#!/usr/bin/env bash
#
# End-to-end test of closing a lead the way Delta CRM closes one: the
# enrolment it needs (course, the client's email, language, payment method,
# receipt, the bonus question), the receipt upload, and the enrolment finance
# receives straight after — with its balance and bonus.
#
# Stands up a throwaway mongod and two copies of this backend — one with file
# storage, one without — with finance and object storage as stand-ins served
# by the test itself. Nothing here touches a configured database or bucket:
# backend/.env names the LIVE draw_crm database, and src/index.ts loads dotenv
# itself, so `bun --no-env-file` alone would not keep it out — DOTENV_CONFIG_PATH
# points at a file that does not exist as well, the storage endpoint is a local
# stand-in, and the driver refuses anything but a scratch database on 127.0.0.1.
#
#   ./scripts/enrolment-close-e2e.sh
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_PORT="${E2E_MONGO_PORT:-27097}"
API_PORT="${E2E_API_PORT:-5101}"
BARE_API_PORT="${E2E_BARE_API_PORT:-5102}"
FINANCE_PORT="${E2E_FAKE_FINANCE_PORT:-5103}"
S3_PORT="${E2E_FAKE_S3_PORT:-5104}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/draw-enrolment-close-e2e.XXXXXX")"

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
  release_port "$API_PORT"
  release_port "$BARE_API_PORT"
  release_port "$FINANCE_PORT"
  release_port "$S3_PORT"
  # macOS builds of mongod have no --shutdown; its listener is stopped like the rest.
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

for port in "$MONGO_PORT" "$API_PORT" "$BARE_API_PORT" "$FINANCE_PORT" "$S3_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use." >&2
    exit 1
  fi
done

mkdir -p "$WORK/db"
echo "Starting a throwaway mongod on :$MONGO_PORT"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/mongo.log" >/dev/null

# Everything the backend and the driver read, and nothing from any .env.
export DOTENV_CONFIG_PATH="$WORK/no-such-dotenv"
export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/draw_enrolment_close_e2e"
export NODE_ENV=test
export JWT_SECRET="draw-enrolment-close-e2e-access-secret-0123456789"
export JWT_REFRESH_SECRET="draw-enrolment-close-e2e-refresh-secret-0123456789"
export LMS_API_URL="" LMS_SERVICE_SECRET="" LMS_REMOTE_ORG_ID="" ROOT_ERP_SECRET=""
export TELEGRAM_BOT_TOKEN="" TELEGRAM_CHAT_ID="" GEMINI_API_KEY=""
# web-push refuses to load without VAPID keys: a throwaway pair, made here.
VAPID="$(cd "$HERE" && bun --no-env-file -e 'const k = require("web-push").generateVAPIDKeys(); console.log(k.publicKey + " " + k.privateKey)')"
export VAPID_PUBLIC_KEY="${VAPID%% *}" VAPID_PRIVATE_KEY="${VAPID##* }"
export E2E_API_PORT="$API_PORT" E2E_BARE_API_PORT="$BARE_API_PORT"
export E2E_FAKE_FINANCE_PORT="$FINANCE_PORT" E2E_FAKE_S3_PORT="$S3_PORT"
# What the test signs and checks as finance, and the bucket it plays.
export E2E_FINANCE_CLIENT_ID="draw-crm-e2e"
export E2E_FINANCE_SECRET="draw-enrolment-close-e2e-inbound-secret-0123"
export E2E_FINANCE_ORG_ID="64b0000000000000000000d8"
export E2E_BUCKET="draw-e2e-receipts"
export E2E_PUBLIC_URL="http://127.0.0.1:$S3_PORT/public"

cd "$HERE"

echo "Starting the Draw CRM backend on :$API_PORT — finance and storage connected"
PORT="$API_PORT" \
  FINANCE_API_URL="http://127.0.0.1:$FINANCE_PORT" FINANCE_CLIENT_ID="$E2E_FINANCE_CLIENT_ID" \
  FINANCE_INTEGRATION_SECRET="$E2E_FINANCE_SECRET" FINANCE_ORG_ID="$E2E_FINANCE_ORG_ID" \
  R2_ACCOUNT_ID="e2e-account" R2_ACCESS_KEY_ID="e2e-key" R2_SECRET_ACCESS_KEY="e2e-secret" \
  R2_BUCKET_NAME="$E2E_BUCKET" R2_PUBLIC_URL="$E2E_PUBLIC_URL" R2_ENDPOINT="http://127.0.0.1:$S3_PORT" \
  bun --no-env-file src/index.ts > "$WORK/api.log" 2>&1 &

# A second copy with neither, sharing the database: what a server that has not
# been given storage settings answers when somebody attaches a receipt.
echo "Starting a second copy on :$BARE_API_PORT — no storage, no finance"
PORT="$BARE_API_PORT" \
  FINANCE_API_URL="" FINANCE_CLIENT_ID="" FINANCE_INTEGRATION_SECRET="" FINANCE_ORG_ID="" \
  R2_ACCOUNT_ID="" R2_ACCESS_KEY_ID="" R2_SECRET_ACCESS_KEY="" R2_BUCKET_NAME="" R2_PUBLIC_URL="" R2_ENDPOINT="" \
  bun --no-env-file src/index.ts > "$WORK/bare-api.log" 2>&1 &

for port in "$API_PORT" "$BARE_API_PORT"; do
  for _ in $(seq 1 80); do
    curl -s -o /dev/null "http://127.0.0.1:$port/api/v1/courses" && break
    sleep 0.25
  done
  curl -s -o /dev/null "http://127.0.0.1:$port/api/v1/courses" || {
    echo "The backend on :$port did not start:" >&2
    tail -30 "$WORK/api.log" "$WORK/bare-api.log" >&2
    exit 1
  }
done
if ! grep -q "127.0.0.1" "$WORK/api.log"; then
  echo "The backend did not report connecting to the scratch database:" >&2
  tail -30 "$WORK/api.log" >&2
  exit 1
fi

echo "Closing leads"
if ! bun --no-env-file src/scripts/enrolmentCloseE2e.ts; then
  echo
  echo "--- last 30 lines of the backend log ---" >&2
  tail -30 "$WORK/api.log" | sed -E 's#mongodb://[^ ]*#<uri>#g' >&2
  exit 1
fi
