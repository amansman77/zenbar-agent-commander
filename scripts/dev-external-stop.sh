#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
TMP_DIR="$ROOT_DIR/tmp"
API_PID_FILE="$TMP_DIR/dev-external-api.pid"
WEB_PID_FILE="$TMP_DIR/dev-external-web.pid"
API_PORT="${ZENBAR_API_PORT:-18000}"
WEB_PORT="${ZENBAR_WEB_PORT:-15173}"

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

stop_port() {
  port="$1"
  name="$2"
  if ! command -v lsof >/dev/null 2>&1; then
    return 0
  fi
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -z "$pids" ]; then
    return 0
  fi
  echo "$name: stopping port $port listeners: $pids"
  for pid in $pids; do
    kill "$pid" 2>/dev/null || true
  done
  sleep 0.3
  remaining="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$remaining" ]; then
    echo "$name: force-stopping port $port listeners: $remaining"
    for pid in $remaining; do
      kill -9 "$pid" 2>/dev/null || true
    done
  fi
}

stop_pid_file "$WEB_PID_FILE" "Web"
stop_pid_file "$API_PID_FILE" "API"
stop_port "$WEB_PORT" "Web"
stop_port "$API_PORT" "API"
