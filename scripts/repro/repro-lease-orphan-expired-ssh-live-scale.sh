#!/usr/bin/env bash
# E2E repro: expired SSH execution_resource_leases survive in a live-scale DB
# and classify as lease-orphan. Then prove global sweep removes them.
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

TMP="$(mktemp -d -t invoker-lease-orphan.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

python3 scripts/repro/lib/live-scale-capacity-fixture.py \
  --db "$TMP/invoker.db" \
  --config "$TMP/config.json" \
  >"$TMP/meta.json"

echo "repro: lease-orphan expired SSH lease on live-scale fixture"
REPORT="$TMP/audit.json"
INVOKER_DB_PATH="$TMP/invoker.db" INVOKER_CONFIG_PATH="$TMP/config.json" \
  bash scripts/repro/capacity-audit.sh --json >"$REPORT"

python3 - "$REPORT" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report["leases"]["expiredCount"] >= 1, report["leases"]
assert "lease-orphan" in report["verdicts"], report["verdicts"]
assert report["occupancy"]["pending"] >= 100, report["occupancy"]
print("PASS: lease-orphan occurs on live-scale fixture", {
  "expiredCount": report["leases"]["expiredCount"],
  "verdicts": report["verdicts"],
})
PY

if [[ "$RUN_GATES" == "1" ]]; then
  echo "gate: global sweep (releaseExpiredExecutionResourceLeases)"
  cd packages/data-store
  pnpm exec vitest run src/__tests__/sqlite-adapter.test.ts -t "globally sweeps expired"
  echo "PASS: expired execution resource leases are globally swept"
fi
