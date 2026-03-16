#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
WEB_HOST="${ZENBAR_WEB_HOST:-127.0.0.1}"
WEB_PORT="${ZENBAR_WEB_PORT:-5173}"

cd "$ROOT_DIR"
exec env COREPACK_HOME=/tmp/corepack pnpm --filter web exec vite --host "$WEB_HOST" --port "$WEB_PORT"
