#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
API_SCRIPT="$ROOT_DIR/scripts/dev-api-external.sh"
WEB_SCRIPT="$ROOT_DIR/scripts/dev-web-external.sh"

"$API_SCRIPT" &
API_PID=$!

cleanup() {
  kill "$API_PID" 2>/dev/null || true
}

trap cleanup INT TERM EXIT

"$WEB_SCRIPT"
