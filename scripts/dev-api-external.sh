#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
API_DIR="$ROOT_DIR/services/api"
VENV_PYTHON="$ROOT_DIR/.venv/bin/python"
API_HOST="${ZENBAR_API_HOST:-0.0.0.0}"
API_PORT="${ZENBAR_API_PORT:-18000}"
WEB_PORT="${ZENBAR_WEB_PORT:-15173}"
ALLOW_REMOTE="${ZENBAR_ALLOW_UNAUTHENTICATED_REMOTE:-false}"
DEFAULT_CORS_ORIGINS="${ZENBAR_CORS_ORIGINS:-}"

load_env_file() {
  env_file="$1"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

load_env_file "$ROOT_DIR/.env.local"
load_env_file "$API_DIR/.env.local"

resolve_public_host() {
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

if [ ! -x "$VENV_PYTHON" ]; then
  echo "Missing virtualenv Python at $VENV_PYTHON"
  echo "Create it first, for example:"
  echo "  python3 -m venv .venv && .venv/bin/pip install -e 'services/api[dev]'"
  exit 1
fi

if [ -z "$DEFAULT_CORS_ORIGINS" ]; then
  PUBLIC_HOST="$(resolve_public_host)"
  DEFAULT_CORS_ORIGINS="http://localhost:$WEB_PORT,http://127.0.0.1:$WEB_PORT,http://$PUBLIC_HOST:$WEB_PORT"
fi

cd "$API_DIR"
exec env \
  ZENBAR_ALLOW_UNAUTHENTICATED_REMOTE="$ALLOW_REMOTE" \
  ZENBAR_CORS_ORIGINS="$DEFAULT_CORS_ORIGINS" \
  "$VENV_PYTHON" -m uvicorn app.main:app --reload --host "$API_HOST" --port "$API_PORT"
