#!/bin/sh
# One-command dev: mock backend (scripts/ui_preview.py) + Vite with hot reload.
# If something is already listening on the mock port (e.g. the Claude preview
# server), the spawned mock exits and Vite simply proxies to the existing one.
PORT="${MOCK_PORT:-5178}"
python3 "$(dirname "$0")/../../scripts/ui_preview.py" --port "$PORT" &
MOCK_PID=$!
trap 'kill "$MOCK_PID" 2>/dev/null' EXIT INT TERM
TALOS_PROXY="http://127.0.0.1:$PORT" pnpm exec vite
