#!/usr/bin/env bash
# E2E repro: cross-task orphaned activeExecutions wedge a pool member so a
# waiter cannot fill capacity. Occurrence is the vitest scenario; live-scale
# audit still shows underfill pressure in the same shape as production.
set -euo pipefail

# Occurrence proof by default. Pass --gate to also run the fix vitest.
RUN_GATES=0
for arg in "$@"; do
  case "$arg" in
    --gate) RUN_GATES=1 ;;
  esac
done


ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d -t invoker-cross-task-orphan.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

python3 scripts/repro/lib/live-scale-capacity-fixture.py \
  --db "$TMP/invoker.db" \
  --config "$TMP/config.json" \
  --running-budget 4 \
  >"$TMP/meta.json"

echo "repro: cross-task pool orphan under live-scale pressure"
REPORT="$TMP/audit.json"
INVOKER_DB_PATH="$TMP/invoker.db" INVOKER_CONFIG_PATH="$TMP/config.json" \
  bash scripts/repro/capacity-audit.sh --json >"$REPORT"

python3 - "$REPORT" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report["occupancy"]["pending"] >= 100, report["occupancy"]
assert report["occupancy"]["occupied"] < report["config"]["expectedCap"], report
print("PASS: live-scale underfill pressure present for orphan reclaim scenario", {
  "occupied": report["occupancy"]["occupied"],
  "expectedCap": report["config"]["expectedCap"],
  "pending": report["occupancy"]["pending"],
})
PY

if [[ "$RUN_GATES" == "1" ]]; then
  echo "gate: cross-task orphan reclaim"
  cd packages/execution-engine
  pnpm exec vitest run src/__tests__/pool-capacity-superseded-execution-leak.test.ts -t "reclaims another task"
  echo "PASS: cross-task orphan reclaim keeps pool members fillable"
fi
