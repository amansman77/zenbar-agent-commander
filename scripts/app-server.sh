#!/bin/sh
# Runs the Codex App Server in the foreground on ZENBAR_APP_SERVER_WS_URL.
#
# This is what the launchd agent from app-server-agent.sh runs. The Docker API
# never starts an App Server itself (ZENBAR_APP_SERVER_MANAGED=false in the
# container), so before this existed it was started by hand and did not come
# back after a reboot: the API then served only the fallback model list and
# the model picker vanished (2026-09-30).
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
# The App Server reads provider credentials such as AZURE_OPENAI_API_KEY from
# its own environment, and ZENBAR_APP_SERVER_COMMAND picks the codex binary.
# Without these it starts and looks healthy, but every task fails at run time.
for env_file in "$ROOT_DIR/.env.local" "$ROOT_DIR/services/api/.env.local"; do
    if [ -f "$env_file" ]; then
        set -a
        . "$env_file"
        set +a
    fi
done

WS_URL="${ZENBAR_APP_SERVER_WS_URL:-ws://127.0.0.1:18765}"
COMMAND="${ZENBAR_APP_SERVER_COMMAND:-$(command -v codex || true)}"
if [ -z "$COMMAND" ]; then
    echo 'Set ZENBAR_APP_SERVER_COMMAND to the absolute path of codex.' >&2
    exit 1
fi
# Same file ManagedAppServer writes, truncated per start like it is, so the
# log is in one place whichever way the App Server was started.
LOG_FILE="${ZENBAR_APP_SERVER_LOG_FILE:-${TMPDIR:-/tmp}/zenbar-app-server.log}"

exec "$COMMAND" app-server --listen "$WS_URL" >"$LOG_FILE" 2>&1
