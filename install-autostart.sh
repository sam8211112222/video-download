#!/bin/bash
# Start the VDD helper automatically at login (macOS LaunchAgent).
# Undo with:  ./install-autostart.sh --remove
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.vdd.helper.plist"
if [ "$1" = "--remove" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true; rm -f "$PLIST"; echo "Autostart removed."; exit 0
fi
[ -x "$DIR/.venv/bin/python" ] || { python3 -m venv "$DIR/.venv"; "$DIR/.venv/bin/pip" install -q -U pip yt-dlp; }
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.vdd.helper</string>
  <key>ProgramArguments</key><array>
    <string>$DIR/.venv/bin/python</string><string>$DIR/server/vdd_server.py</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/vdd-helper.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
pkill -f "server/vdd_server.py" 2>/dev/null || true   # free the port from a manually started helper
sleep 1
launchctl load "$PLIST"
echo "VDD helper will now run at login. Open http://127.0.0.1:17723/"
