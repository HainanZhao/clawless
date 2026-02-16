#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <chatId-or-channelId> [message]" >&2
  exit 1
fi

CHAT_ID="$1"
MESSAGE="${2:-Callback test to explicit destination from clawless}"
BASE_URL="${CALLBACK_BASE_URL:-http://127.0.0.1:8788}"
ENDPOINT="$BASE_URL/callback"

if [[ -n "${CALLBACK_AUTH_TOKEN:-}" ]]; then
  curl -sS -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "x-callback-token: ${CALLBACK_AUTH_TOKEN}" \
    -d "{\"chatId\":\"${CHAT_ID//\"/\\\"}\",\"text\":\"${MESSAGE//\"/\\\"}\"}"
else
  curl -sS -X POST "$ENDPOINT" \
    -H "Content-Type: application/json" \
    -d "{\"chatId\":\"${CHAT_ID//\"/\\\"}\",\"text\":\"${MESSAGE//\"/\\\"}\"}"
fi

echo
