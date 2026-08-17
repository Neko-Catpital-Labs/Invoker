#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MAIN_JS="$REPO_ROOT/packages/app/dist/main.js"

PIDS="$(pgrep -f "$MAIN_JS" 2>/dev/null || true)"
if [ -z "$PIDS" ]; then
  exit 0
fi

while IFS= read -r pid; do
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
done <<< "$PIDS"

for _ in {1..20}; do
  if ! pgrep -f "$MAIN_JS" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.1
done

PIDS="$(pgrep -f "$MAIN_JS" 2>/dev/null || true)"
while IFS= read -r pid; do
  [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null || true
done <<< "$PIDS"
