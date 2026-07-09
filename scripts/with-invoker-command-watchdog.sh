#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      break
      ;;
    --interval|--max|--commands|--action|--owner-pid|--snapshot-file)
      WATCHDOG_ARGS+=("$1" "$2")
      shift 2
      ;;
    --help|-h)
      echo "usage: $0 [watchdog options] -- <command> [args...]" >&2
      exit 0
      ;;
    *) break ;;
  esac
done

if [[ $# -lt 1 ]]; then
  echo "usage: $0 [watchdog options] -- <command> [args...]" >&2
  exit 2
fi

"$REPO_ROOT/scripts/watch-invoker-command-concurrency.sh" "${WATCHDOG_ARGS[@]}" &
watchdog_pid=$!

cleanup() {
  if kill -0 "$watchdog_pid" 2>/dev/null; then
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

"$@" &
command_pid=$!

command_status=0
watchdog_status=0

while true; do
  if ! kill -0 "$command_pid" 2>/dev/null; then
    wait "$command_pid" || command_status=$?
    cleanup
    exit "$command_status"
  fi
  if ! kill -0 "$watchdog_pid" 2>/dev/null; then
    wait "$watchdog_pid" || watchdog_status=$?
    kill "$command_pid" 2>/dev/null || true
    wait "$command_pid" 2>/dev/null || true
    exit "$watchdog_status"
  fi
  sleep 1
done
