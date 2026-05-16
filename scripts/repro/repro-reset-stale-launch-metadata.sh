#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-reset-stale-launch-metadata.sh --expect-issue
  bash scripts/repro/repro-reset-stale-launch-metadata.sh --expect-fixed

What it proves:
  Reset-to-pending paths must clear stale execution.phase,
  execution.launchStartedAt, and execution.launchCompletedAt values.

Exit codes:
  0  observed behavior matches expectation
  1  observed behavior does not match expectation
  2  invalid repro usage
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue)
      EXPECTATION="issue"
      shift
      ;;
    --expect-fixed)
      EXPECTATION="fixed"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "issue" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: choose --expect-issue or --expect-fixed" >&2
  usage >&2
  exit 2
fi

cd "$ROOT_DIR"

set +e
pnpm --filter @invoker/workflow-core exec vitest run \
  --reporter verbose \
  src/__tests__/orchestrator-dispatcher.test.ts \
  -t "clears stale launch metadata"
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  OBSERVED="fixed"
else
  OBSERVED="issue"
fi

echo "reset_stale_launch_metadata_exit     : $STATUS"
echo "reset_stale_launch_metadata_observed : $OBSERVED"
echo "expected                             : $EXPECTATION"

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  exit 1
fi

echo "==> repro matched expectation"
