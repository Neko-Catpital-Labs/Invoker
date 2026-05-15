#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-mece-10-stale-launch-metadata.sh --expect bug|fixed

What it proves:
  Persisted terminal tasks whose launchStartedAt predates their real start by
  hours are compatibility-normalized so old retry-storm rows stop reporting
  stale launch metadata, while legitimate long executions keep launch timing.

Exit codes:
  0  observed behavior matches --expect
  1  observed behavior does not match --expect
  2  repro setup or assertion was invalid / unexpected
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
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

if [[ "$EXPECTATION" != "bug" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: --expect requires bug|fixed" >&2
  usage >&2
  exit 2
fi

cd "$ROOT_DIR"

set +e
pnpm --filter @invoker/data-store exec vitest run \
  --reporter verbose \
  -t "normalizes stale terminal launch metadata without touching legitimate long executions" \
  src/__tests__/sqlite-adapter.test.ts
STATUS=$?
set -e

if [[ "$STATUS" -eq 0 ]]; then
  OBSERVED="fixed"
else
  OBSERVED="bug"
fi

echo "stale_launch_metadata_exit     : $STATUS"
echo "stale_launch_metadata_observed : $OBSERVED"
echo "expected                       : $EXPECTATION"

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  exit 1
fi

echo "==> repro matched expectation"
