#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${CALLBACK_BASE_URL:-http://127.0.0.1:8788}"
ENDPOINT="$BASE_URL/callback/telegram"
MESSAGE="${1:-Callback test from clawless}"

if [[ -n "${CALLBACK_AUTH_TOKEN:-}" ]]; then
  curl -sS -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "x-callback-token: ${CALLBACK_AUTH_TOKEN}" \
    -d "{\"text\":\"${MESSAGE//\"/\\\"}\"}"
else
  curl -sS -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "{\"text\":\"${MESSAGE//\"/\\\"}\"}"
fi

echo
