#!/bin/sh
# Installs (or removes) a launchd user agent that keeps the Codex App Server
# running: started at login, and restarted if it exits. It also covers the
# crash case ManagedAppServer never did, since that only spawns it once.
#
#   sh scripts/app-server-agent.sh install
#   sh scripts/app-server-agent.sh uninstall
#
# A dev API with ZENBAR_APP_SERVER_MANAGED=true finds this one already ready on
# the same URL and uses it instead of spawning its own.
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
LABEL="com.zenbar.app-server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
    install)
        mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
        cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array>
    <string>/bin/sh</string>
    <string>$ROOT_DIR/scripts/app-server.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/$LABEL.log</string>
</dict></plist>
EOF
        launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
        launchctl bootstrap "$DOMAIN" "$PLIST"
        echo "Installed $PLIST"
        ;;
    uninstall)
        launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
        rm -f "$PLIST"
        echo "Removed $PLIST"
        ;;
    *)
        echo "usage: $0 install|uninstall" >&2
        exit 1
        ;;
esac
