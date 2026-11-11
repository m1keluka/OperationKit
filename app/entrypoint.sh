#!/bin/bash
# Entrypoint that keeps tmux alive across Node server restarts.
# tmux sessions (Claude Code) persist while only the server process cycles.
set -e

# Start tmux server in the background (survives Node restarts)
tmux start-server 2>/dev/null || true

# Loop: restart the Node server when it exits (backend deploy = process.exit(0))
while true; do
  echo "[entrypoint] Starting Node server..."
  tsx server/src/index.ts || true
  EXIT_CODE=$?
  echo "[entrypoint] Node server exited with code $EXIT_CODE — restarting in 2s..."
  sleep 2
done
