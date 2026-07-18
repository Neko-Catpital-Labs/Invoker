#!/usr/bin/env bash
# E2E repro: live-scale DB with many ready pending roots and no active launch
# outbox rows → capacity-audit ready-no-dispatch. Then prove stranded top-up.
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

TMP="$(mktemp -d -t invoker-ready-no-dispatch.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

python3 scripts/repro/lib/live-scale-capacity-fixture.py \
  --db "$TMP/invoker.db" \
  --config "$TMP/config.json" \
  --running-budget 4 \
  >"$TMP/meta.json"

echo "repro: ready-no-dispatch live-scale fixture"
python3 -c 'import json; m=json.load(open("'"$TMP"'/meta.json")); assert m["ready_without_dispatch"]>=20, m; print(m)'

REPORT="$TMP/audit.json"
INVOKER_DB_PATH="$TMP/invoker.db" INVOKER_CONFIG_PATH="$TMP/config.json" \
  bash scripts/repro/capacity-audit.sh --json >"$REPORT"

python3 - "$REPORT" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report["occupancy"]["readyWithoutDispatchCount"] >= 20, report["occupancy"]
assert "ready-no-dispatch" in report["verdicts"], report["verdicts"]
assert report["occupancy"]["occupied"] < report["config"]["expectedCap"], {
  "occupied": report["occupancy"]["occupied"],
  "expectedCap": report["config"]["expectedCap"],
}
print("PASS: ready-no-dispatch occurs on live-scale fixture", {
  "readyWithoutDispatchCount": report["occupancy"]["readyWithoutDispatchCount"],
  "occupied": report["occupancy"]["occupied"],
  "expectedCap": report["config"]["expectedCap"],
  "verdicts": report["verdicts"],
})
PY

if [[ "$RUN_GATES" == "1" ]]; then
  echo "gate: stranded ready top-up"
  cd packages/app
  pnpm exec vitest run src/__tests__/launch-dispatcher.test.ts -t "re-tops stranded ready"
  echo "PASS: LaunchDispatcher re-tops stranded ready work when slots are free"
fi
