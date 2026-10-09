#!/bin/sh
# Runs Zenbar as three launchd user agents on this Mac:
#
#   com.zenbar.app-server  Codex App Server   ws://127.0.0.1:18765 (scripts/app-server.sh)
#   com.zenbar.api         Orchestration API  http://127.0.0.1:18001
#   com.zenbar.dashboard   Web Commander      http://127.0.0.1:8080, proxying /api
#
# Each starts at login and is restarted if it exits. This replaced the Docker
# containers (2026-10-09): the CLI engines (claude, agy, grok) only exist on
# the host, so inside a container Claude usage came back empty and those
# engines could not run a task at all.
#
#   sh scripts/services.sh install       write the plists and start everything
#   sh scripts/services.sh uninstall     stop everything and remove the plists
#   sh scripts/services.sh restart [api|dashboard|app-server]
#   sh scripts/services.sh deploy-web    rebuild the dashboard bundle (served live, no restart)
#   sh scripts/services.sh status
#
# run-api and run-dashboard are what the plists execute.
#
# The database is $ZENBAR_HOME/zenbar.db (default ~/.zenbar), deliberately
# outside the repo. services/api/zenbar.db is what `pnpm dev` uses, and it is
# an old copy, so the service must never fall back to it.
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ZENBAR_HOME="${ZENBAR_HOME:-$HOME/.zenbar}"
VENV_PYTHON="$ROOT_DIR/.venv/bin/python"
DOMAIN="gui/$(id -u)"
LABELS="com.zenbar.app-server com.zenbar.api com.zenbar.dashboard"

load_env() {
    for env_file in "$ROOT_DIR/.env.local" "$ROOT_DIR/services/api/.env.local"; do
        if [ -f "$env_file" ]; then
            set -a
            . "$env_file"
            set +a
        fi
    done
    # launchd starts agents with only /usr/bin:/bin:/usr/sbin:/sbin. The CLI
    # engines live in ~/.local/bin, and gh (PR merge on approval) in Homebrew.
    export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
}

plist_path() {
    echo "$HOME/Library/LaunchAgents/$1.plist"
}

write_plist() {
    label="$1"
    shift
    args=""
    for arg in "$@"; do
        args="$args    <string>$arg</string>
"
    done
    cat >"$(plist_path "$label")" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
$args  </array>
  <key>WorkingDirectory</key><string>$ROOT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/$label.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$label.log</string>
</dict></plist>
EOF
}

case "${1:-}" in
    run-api)
        load_env
        # Set after the env files on purpose: services/api/.env.local points
        # ZENBAR_DATABASE_URL at the dev database. The App Server is its own
        # launchd agent, and a managed one here would fight it for the port.
        export ZENBAR_DATABASE_URL="sqlite:///$ZENBAR_HOME/zenbar.db"
        export ZENBAR_APP_SERVER_MANAGED=false
        if [ ! -f "$ZENBAR_HOME/zenbar.db" ]; then
            echo "No database at $ZENBAR_HOME/zenbar.db" >&2
            exit 1
        fi
        cd "$ROOT_DIR/services/api"
        exec "$VENV_PYTHON" -m uvicorn app.main:app --host 127.0.0.1 --port "${ZENBAR_SERVICE_API_PORT:-18001}"
        ;;
    run-dashboard)
        load_env
        export ZENBAR_DASHBOARD_DIST="$ZENBAR_HOME/dashboard"
        export ZENBAR_API_UPSTREAM="${ZENBAR_API_UPSTREAM:-http://127.0.0.1:${ZENBAR_SERVICE_API_PORT:-18001}}"
        exec "$VENV_PYTHON" "$ROOT_DIR/scripts/dashboard_server.py"
        ;;
    deploy-web)
        # Its own output directory, so `pnpm build` for development never
        # overwrites what the dashboard is serving. A relative API base means
        # the bundle calls the dashboard's own /api proxy, and no token is
        # baked into it.
        mkdir -p "$ZENBAR_HOME"
        cd "$ROOT_DIR/apps/web"
        pnpm exec tsc -b
        VITE_API_BASE_URL=/api VITE_API_TOKEN="" pnpm exec vite build --outDir "$ZENBAR_HOME/dashboard" --emptyOutDir
        ;;
    install)
        mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs" "$ZENBAR_HOME"
        if [ ! -f "$ZENBAR_HOME/zenbar.db" ]; then
            echo "Put the database at $ZENBAR_HOME/zenbar.db before installing." >&2
            exit 1
        fi
        if [ ! -f "$ZENBAR_HOME/dashboard/index.html" ]; then
            sh "$ROOT_DIR/scripts/services.sh" deploy-web
        fi
        write_plist com.zenbar.app-server /bin/sh "$ROOT_DIR/scripts/app-server.sh"
        write_plist com.zenbar.api /bin/sh "$ROOT_DIR/scripts/services.sh" run-api
        write_plist com.zenbar.dashboard /bin/sh "$ROOT_DIR/scripts/services.sh" run-dashboard
        for label in $LABELS; do
            launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
            # bootout returns before the job is actually gone, and bootstrapping
            # a label that is still unloading fails with "5: Input/output
            # error". That happened on the first real install, and it left the
            # already-running App Server stopped.
            tries=0
            while launchctl print "$DOMAIN/$label" >/dev/null 2>&1 && [ "$tries" -lt 50 ]; do
                sleep 0.2
                tries=$((tries + 1))
            done
            launchctl bootstrap "$DOMAIN" "$(plist_path "$label")"
        done
        echo "Installed: $LABELS"
        ;;
    uninstall)
        for label in $LABELS; do
            launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
            rm -f "$(plist_path "$label")"
        done
        echo "Removed: $LABELS"
        ;;
    restart)
        for label in ${2:-api dashboard app-server}; do
            launchctl kickstart -k "$DOMAIN/com.zenbar.${label#com.zenbar.}"
        done
        ;;
    status)
        for label in $LABELS; do
            state="$(launchctl print "$DOMAIN/$label" 2>/dev/null | awk '/^\tstate =/ {print $3; exit}')"
            printf '%-24s %s\n' "$label" "${state:-not installed}"
        done
        ;;
    *)
        echo "usage: $0 install|uninstall|restart [api|dashboard|app-server]|deploy-web|status" >&2
        exit 1
        ;;
esac
