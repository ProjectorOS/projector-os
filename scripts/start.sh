#!/usr/bin/env bash
# Boots the ProjectorOS server + Vite dev server and opens the control panel
# in your default browser. The control panel itself launches the projector
# kiosk window onto whichever display you pick from its UI.

set -euo pipefail

SERVER_PORT="${SERVER_PORT:-8000}"
UI_PORT="${UI_PORT:-5173}"

cd "$(dirname "$0")/.."

if [ ! -d ".venv" ]; then
  echo "no .venv found. Create one with: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt"
  exit 1
fi

if [ ! -d "ui/node_modules" ]; then
  echo "no ui/node_modules. Run: (cd ui && npm install)"
  exit 1
fi

cleanup() {
  kill "${SERVER_PID:-}" "${UI_PID:-}" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

UI_PORT="$UI_PORT" .venv/bin/python -m server.main &
SERVER_PID=$!

(cd ui && npm run dev -- --port "$UI_PORT") &
UI_PID=$!

sleep 2

CONTROL_URL="http://localhost:$UI_PORT/control.html"
echo "Control panel: $CONTROL_URL"
open "$CONTROL_URL"

wait
