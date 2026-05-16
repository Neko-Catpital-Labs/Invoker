#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-poller-stale-launch-dag-violation.sh --expect-issue
  bash scripts/repro/repro-poller-stale-launch-dag-violation.sh --expect-fixed

What it proves:
  The app poller must not treat reset-created pending attempts with stale
  launching metadata as real launch stalls before dependencies are satisfied.

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
pnpm --filter @invoker/app exec vitest run \
  --reporter verbose \
  src/__tests__/launch-stall.test.ts
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  OBSERVED="fixed"
else
  OBSERVED="issue"
fi

echo "poller_stale_launch_dag_violation_exit     : $STATUS"
echo "poller_stale_launch_dag_violation_observed : $OBSERVED"
echo "expected                                   : $EXPECTATION"

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  exit 1
fi

echo "==> repro matched expectation"
