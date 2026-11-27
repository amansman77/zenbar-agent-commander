#!/bin/sh
# Runs the Codex App Server in the foreground on ZENBAR_APP_SERVER_WS_URL.
#
#   app-server.sh                      the default App Server (config.toml's provider)
#   app-server.sh <provider> <ws-url>  one pinned to <provider>, e.g. azure ws://127.0.0.1:18766
#
# Codex 0.166 (openai/codex#57840) only accepts input on a thread whose
# provider matches the App Server's current provider: config.toml plus launch
# overrides, never a per-request override. One App Server can therefore serve
# only one provider, and a profile on another provider gets its own server.
#
# This is what the com.zenbar.app-server launchd agent runs (scripts/services.sh).
# The API never starts an App Server itself when run as a service
# (ZENBAR_APP_SERVER_MANAGED=false). Before this agent existed it was started by
# hand and did not come back after a reboot: the API then served only the
# fallback model list and the model picker vanished (2026-09-30).
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

# launchd may omit the Node.js installation used by Playwright.
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

PROVIDER="${1:-}"
if [ -n "$PROVIDER" ]; then
    WS_URL="${2:?usage: app-server.sh <provider> <ws-url>}"
else
    WS_URL="${ZENBAR_APP_SERVER_WS_URL:-ws://127.0.0.1:18765}"
fi
COMMAND="${ZENBAR_APP_SERVER_COMMAND:-$(command -v codex || true)}"
if [ -z "$COMMAND" ]; then
    echo 'Set ZENBAR_APP_SERVER_COMMAND to the absolute path of codex.' >&2
    exit 1
fi
# Same file ManagedAppServer writes, truncated per start like it is, so the
# log is in one place whichever way the App Server was started.
LOG_FILE="${ZENBAR_APP_SERVER_LOG_FILE:-${TMPDIR:-/tmp}/zenbar-app-server.log}"

set -- app-server --listen "$WS_URL" \
    -c 'mcp_servers.zenbar_browser.command="npx"' \
    -c 'mcp_servers.zenbar_browser.args=["--yes","--prefer-offline","@playwright/mcp@0.0.85","--headless","--isolated","--browser","chromium"]' \
    -c 'mcp_servers.zenbar_browser.startup_timeout_sec=60'
if [ -n "$PROVIDER" ]; then
    LOG_FILE="${TMPDIR:-/tmp}/zenbar-app-server-$PROVIDER.log"
    set -- -c "model_provider=\"$PROVIDER\"" "$@"
fi
exec "$COMMAND" "$@" >"$LOG_FILE" 2>&1
