#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
API_DIR="$ROOT_DIR/services/api"
VENV_PYTHON="$ROOT_DIR/.venv/bin/python"
API_HOST="${ZENBAR_API_HOST:-0.0.0.0}"
API_PORT="${ZENBAR_API_PORT:-18000}"

if [ ! -x "$VENV_PYTHON" ]; then
  echo "Missing virtualenv Python at $VENV_PYTHON"
  echo "Create it first, for example:"
  echo "  python3 -m venv .venv && .venv/bin/pip install -e 'services/api[dev]'"
  exit 1
fi

cd "$API_DIR"
exec "$VENV_PYTHON" -m uvicorn app.main:app --reload --host "$API_HOST" --port "$API_PORT"
