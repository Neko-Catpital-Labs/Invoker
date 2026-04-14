#!/usr/bin/env bash
set -euo pipefail

pattern='Electron|electron'

if ! pgrep -af "$pattern" >/dev/null 2>&1; then
  echo "No Electron processes found"
  exit 0
fi

echo "Electron processes before kill:"
pgrep -af "$pattern"

pkill -f "$pattern" 2>/dev/null || true

for _ in $(seq 1 10); do
  if ! pgrep -af "$pattern" >/dev/null 2>&1; then
    echo "All Electron processes stopped"
    exit 0
  fi
  sleep 0.5
done

echo "Forcing SIGKILL on remaining Electron processes..."
pkill -9 -f "$pattern" 2>/dev/null || true
sleep 0.5

if pgrep -af "$pattern" >/dev/null 2>&1; then
  echo "Some Electron processes are still running:"
  pgrep -af "$pattern"
  exit 1
fi

echo "All Electron processes killed"
