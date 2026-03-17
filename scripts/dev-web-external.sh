#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
WEB_HOST="${ZENBAR_WEB_HOST:-0.0.0.0}"
WEB_PORT="${ZENBAR_WEB_PORT:-15173}"
API_PORT="${ZENBAR_API_PORT:-18000}"

resolve_host() {
  if [ -n "${ZENBAR_PUBLIC_HOST:-}" ]; then
    printf "%s" "$ZENBAR_PUBLIC_HOST"
    return
  fi
  if command -v tailscale >/dev/null 2>&1; then
    TS_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
    if [ -n "$TS_IP" ]; then
      printf "%s" "$TS_IP"
      return
    fi
  fi
  printf "127.0.0.1"
}

API_HOST="$(resolve_host)"
API_BASE="${VITE_API_BASE_URL:-http://$API_HOST:$API_PORT}"
API_TOKEN="${VITE_API_TOKEN:-${ZENBAR_API_TOKEN:-}}"
COREPACK_HOME="${COREPACK_HOME:-/tmp/corepack}"

echo "Web external mode"
echo "  Web bind: $WEB_HOST:$WEB_PORT"
echo "  API base: $API_BASE"
if [ -n "$API_TOKEN" ]; then
  echo "  API token: configured"
fi

cd "$ROOT_DIR"
if ! env COREPACK_HOME="$COREPACK_HOME" corepack pnpm --version >/dev/null 2>&1; then
  echo "Repairing Corepack pnpm cache at $COREPACK_HOME ..."
  rm -rf "$COREPACK_HOME/v1/pnpm" >/dev/null 2>&1 || true
  env COREPACK_HOME="$COREPACK_HOME" corepack install
fi
if [ -n "$API_TOKEN" ]; then
  exec env COREPACK_HOME="$COREPACK_HOME" VITE_API_BASE_URL="$API_BASE" VITE_API_TOKEN="$API_TOKEN" corepack pnpm --filter web exec vite --host "$WEB_HOST" --port "$WEB_PORT"
fi
exec env COREPACK_HOME="$COREPACK_HOME" VITE_API_BASE_URL="$API_BASE" corepack pnpm --filter web exec vite --host "$WEB_HOST" --port "$WEB_PORT"
