#!/usr/bin/env bash
# E2E repro: live-shaped config maxConcurrency=13 overcommits pool capacity=12.
# Proves the config-overcommit underfill class can occur (audit verdict).
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

TMP="$(mktemp -d -t invoker-config-overcommit.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

python3 scripts/repro/lib/live-scale-capacity-fixture.py \
  --db "$TMP/invoker.db" \
  --config "$TMP/config.json" \
  --max-concurrency 13 \
  >"$TMP/meta.json"

echo "repro: config-overcommit live-scale fixture"
python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m)' "$TMP/meta.json"

REPORT="$TMP/audit.json"
INVOKER_DB_PATH="$TMP/invoker.db" INVOKER_CONFIG_PATH="$TMP/config.json" \
  bash scripts/repro/capacity-audit.sh --json >"$REPORT"

python3 - "$REPORT" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
assert report["config"]["maxConcurrency"] == 13, report["config"]
assert report["config"]["poolCapacity"] == 12, report["config"]
assert report["config"]["overcommitDelta"] == 1, report["config"]
assert "config-overcommit" in report["verdicts"], report["verdicts"]
assert report["occupancy"]["pending"] >= 100, report["occupancy"]
print("PASS: config-overcommit occurs on live-scale fixture", {
  "verdicts": report["verdicts"],
  "overcommitDelta": report["config"]["overcommitDelta"],
  "workflows_pending": report["occupancy"]["pending"],
})
PY

if [[ "$RUN_GATES" == "1" ]]; then
  echo "gate: clamp maxConcurrency"
  cd packages/app
  pnpm exec vitest run src/__tests__/execution-capacity.test.ts -t "clamps maxConcurrency"
  echo "PASS: resolveClampedMaxConcurrency closes the config-overcommit lie"
fi
