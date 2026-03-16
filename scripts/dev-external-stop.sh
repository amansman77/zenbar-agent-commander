#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TMP_DIR="$ROOT_DIR/tmp"
API_PID_FILE="$TMP_DIR/dev-external-api.pid"
WEB_PID_FILE="$TMP_DIR/dev-external-web.pid"

stop_pid_file() {
  pid_file="$1"
  name="$2"
  if [ ! -f "$pid_file" ]; then
    echo "$name: not running"
    return 0
  fi
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "$name: stopped pid=$pid"
  else
    echo "$name: stale pid file"
  fi
  rm -f "$pid_file"
}

stop_pid_file "$WEB_PID_FILE" "Web"
stop_pid_file "$API_PID_FILE" "API"
