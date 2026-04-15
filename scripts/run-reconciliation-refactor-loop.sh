#!/usr/bin/env bash
# Run reconciliation auto-selection in a long-running loop.
# Default interval is 10 minutes.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORKER_SCRIPT="$REPO_ROOT/scripts/auto-select-reconciliation-refactor.sh"
INTERVAL_SECONDS=600
RUN_ONCE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval)
      INTERVAL_SECONDS="${2:-}"
      if [[ -z "$INTERVAL_SECONDS" ]]; then
        echo "Missing value for --interval" >&2
        exit 1
      fi
      shift 2
      ;;
    --once)
      RUN_ONCE=true
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Usage: $0 [--interval <seconds>] [--once]" >&2
      exit 1
      ;;
  esac
done

if ! [[ "$INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --interval value: $INTERVAL_SECONDS (expected integer >= 1)" >&2
  exit 1
fi

if [[ ! -x "$WORKER_SCRIPT" ]]; then
  echo "ERROR: expected executable worker script at $WORKER_SCRIPT" >&2
  exit 1
fi

run_cycle() {
  echo "[$(date -Is)] Starting reconciliation refactor auto-select cycle"
  if bash "$WORKER_SCRIPT"; then
    echo "[$(date -Is)] Cycle completed successfully"
  else
    code=$?
    echo "[$(date -Is)] Cycle failed with exit $code"
  fi
}

if [[ "$RUN_ONCE" == true ]]; then
  run_cycle
  exit 0
fi

echo "Running loop with interval=${INTERVAL_SECONDS}s (Ctrl-C to stop)"
while true; do
  run_cycle
  echo "[$(date -Is)] Sleeping ${INTERVAL_SECONDS}s"
  sleep "$INTERVAL_SECONDS"
done
