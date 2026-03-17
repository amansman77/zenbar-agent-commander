#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
WEB_HOST="${ZENBAR_WEB_HOST:-127.0.0.1}"
WEB_PORT="${ZENBAR_WEB_PORT:-5173}"
COREPACK_HOME="${COREPACK_HOME:-/tmp/corepack}"

cd "$ROOT_DIR"
if ! env COREPACK_HOME="$COREPACK_HOME" corepack pnpm --version >/dev/null 2>&1; then
  echo "Repairing Corepack pnpm cache at $COREPACK_HOME ..."
  rm -rf "$COREPACK_HOME/v1/pnpm" >/dev/null 2>&1 || true
  env COREPACK_HOME="$COREPACK_HOME" corepack install
fi
exec env COREPACK_HOME="$COREPACK_HOME" corepack pnpm --filter web exec vite --host "$WEB_HOST" --port "$WEB_PORT"
