#!/usr/bin/env bash
set -euo pipefail

EXPECTATION=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-ssh-post-close-heartbeat-stale.sh --expect issue|fixed

What it proves:
  If an SSH child process closes and the executor marks the in-memory entry
  completed before slow post-close finalization finishes, heartbeats can stop
  while no completion has been emitted. A watchdog can then report execution
  stalled due to stale heartbeat/no live completion.

Portable mode:
  Uses the existing self-contained Python timing model in
  repro-heartbeat-timeout-after-close-finalize-hang.sh.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "issue" && "$EXPECTATION" != "fixed" ]]; then
  echo "--expect must be issue or fixed" >&2
  usage >&2
  exit 2
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

set +e
output="$(bash scripts/repro/repro-heartbeat-timeout-after-close-finalize-hang.sh 2>&1)"
status=$?
set -e

if [[ "$status" -eq 0 ]] && grep -Fq "PASS: reproduced heartbeat timeout" <<<"$output"; then
  OBSERVED="issue"
else
  OBSERVED="fixed"
fi

echo "$output"
echo "observed=$OBSERVED"
echo "expected=$EXPECTATION"

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  exit 1
fi

echo "==> repro matched expectation"
