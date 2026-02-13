#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${CALLBACK_BASE_URL:-http://127.0.0.1:8787}"
curl -sS "$BASE_URL/healthz"
echo
