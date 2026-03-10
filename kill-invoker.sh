#!/bin/bash
# Kill all running Invoker Electron instances and wait for them to die
if pkill -f "electron.*dist/main.js" 2>/dev/null; then
  echo "Sent SIGTERM to Invoker processes, waiting..."
  # Wait up to 5s for graceful shutdown
  for i in $(seq 1 10); do
    pgrep -f "electron.*dist/main.js" >/dev/null 2>&1 || { echo "Invoker stopped"; exit 0; }
    sleep 0.5
  done
  # Still alive — force kill
  echo "Forcing SIGKILL..."
  pkill -9 -f "electron.*dist/main.js" 2>/dev/null
  sleep 0.5
  echo "Invoker killed"
else
  echo "No Invoker processes found"
fi
