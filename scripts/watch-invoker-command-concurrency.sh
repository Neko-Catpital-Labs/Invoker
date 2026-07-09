#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="$REPO_ROOT/scripts/invoker-command-concurrency-watchdog.mjs"
INTERVAL=10
MAX=1
COMMANDS="claude,codex,pnpm"
ACTION="kill-owner"
OWNER_PID=""
SNAPSHOT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) INTERVAL="$2"; shift 2 ;;
    --max) MAX="$2"; shift 2 ;;
    --commands) COMMANDS="$2"; shift 2 ;;
    --action) ACTION="$2"; shift 2 ;;
    --owner-pid) OWNER_PID="$2"; shift 2 ;;
    --snapshot-file) SNAPSHOT_FILE="$2"; shift 2 ;;
    --help|-h)
      echo "usage: $0 [--interval seconds] [--max N] [--commands a,b] [--action kill-owner|report] [--owner-pid PID] [--snapshot-file PATH]" >&2
      exit 0
      ;;
    *) echo "watch-invoker-command-concurrency: unknown argument: $1" >&2; exit 2 ;;
  esac
done

args=(--max "$MAX" --commands "$COMMANDS" --action "$ACTION" --repo-root "$REPO_ROOT")
if [[ -n "$OWNER_PID" ]]; then args+=(--owner-pid "$OWNER_PID"); fi
if [[ -n "$SNAPSHOT_FILE" ]]; then args+=(--snapshot-file "$SNAPSHOT_FILE"); fi

while true; do
  node "$HELPER" "${args[@]}"
  if [[ -n "$SNAPSHOT_FILE" ]]; then exit 0; fi
  sleep "$INTERVAL"
done
