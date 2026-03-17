#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
API_DIR="$ROOT_DIR/services/api"
VENV_PYTHON="$ROOT_DIR/.venv/bin/python"

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

if [ ! -x "$VENV_PYTHON" ]; then
  echo "Missing virtualenv Python at $VENV_PYTHON"
  echo "Create it first, for example:"
  echo "  python3 -m venv .venv && .venv/bin/pip install -e 'services/api[dev]'"
  exit 1
fi

cd "$API_DIR"
exec "$VENV_PYTHON" -m uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
