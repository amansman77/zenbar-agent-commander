#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
API_SCRIPT="$ROOT_DIR/scripts/dev-api-external.sh"
WEB_SCRIPT="$ROOT_DIR/scripts/dev-web-external.sh"
TMP_DIR="$ROOT_DIR/tmp"
API_PID_FILE="$TMP_DIR/dev-external-api.pid"
WEB_PID_FILE="$TMP_DIR/dev-external-web.pid"
API_LOG_FILE="$TMP_DIR/dev-external-api.log"
WEB_LOG_FILE="$TMP_DIR/dev-external-web.log"
API_PORT="${ZENBAR_API_PORT:-18000}"
WEB_PORT="${ZENBAR_WEB_PORT:-15173}"

mkdir -p "$TMP_DIR"

is_running() {
  pid_file="$1"
  if [ ! -f "$pid_file" ]; then
    return 1
  fi
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -z "$pid" ]; then
    return 1
  fi
  kill -0 "$pid" 2>/dev/null
}

is_port_in_use() {
  port="$1"
  if ! command -v lsof >/dev/null 2>&1; then
    return 1
  fi
  lsof -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

cleanup_pid() {
  pid_file="$1"
  if [ -f "$pid_file" ]; then
    rm -f "$pid_file"
  fi
}

start_bg_process() {
  name="$1"
  script_path="$2"
  pid_file="$3"
  log_file="$4"

  nohup sh "$script_path" >"$log_file" 2>&1 &
  pid=$!
  echo "$pid" >"$pid_file"

  # Give the process a moment to fail fast (env parse errors, missing deps, etc).
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$name failed to start (pid $pid exited early)."
    echo "Recent $name log:"
    tail -n 40 "$log_file" 2>/dev/null || true
    cleanup_pid "$pid_file"
    return 1
  fi
  return 0
}

if is_running "$API_PID_FILE" || is_running "$WEB_PID_FILE"; then
  echo "External dev server is already running."
  echo "Stop first: pnpm dev:external:stop"
  exit 1
fi

if is_port_in_use "$API_PORT" || is_port_in_use "$WEB_PORT"; then
  echo "Required port is already in use (api:$API_PORT or web:$WEB_PORT)."
  echo "Run: pnpm dev:external:stop"
  exit 1
fi

if ! start_bg_process "API" "$API_SCRIPT" "$API_PID_FILE" "$API_LOG_FILE"; then
  exit 1
fi
API_PID="$(cat "$API_PID_FILE")"

if ! start_bg_process "Web" "$WEB_SCRIPT" "$WEB_PID_FILE" "$WEB_LOG_FILE"; then
  # Prevent orphan API process when web startup fails.
  kill "$API_PID" 2>/dev/null || true
  cleanup_pid "$API_PID_FILE"
  exit 1
fi
WEB_PID="$(cat "$WEB_PID_FILE")"

echo "Started external dev servers in background."
echo "  API pid: $API_PID (log: $API_LOG_FILE)"
echo "  Web pid: $WEB_PID (log: $WEB_LOG_FILE)"
echo "Stop with: pnpm dev:external:stop"
