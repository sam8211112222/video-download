#!/bin/bash
# Double-click to start the VDD helper (keeps running while this window is open).
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "First run: setting up (installs yt-dlp into ./.venv)…"
  python3 -m venv .venv && .venv/bin/pip install -q -U pip yt-dlp || exit 1
fi
.venv/bin/pip install -q -U yt-dlp >/dev/null 2>&1 &   # keep yt-dlp fresh (sites change often)
open "http://127.0.0.1:17723/" 2>/dev/null &
exec .venv/bin/python server/vdd_server.py
