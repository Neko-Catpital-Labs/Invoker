#!/usr/bin/env bash
# Repro: CodeRabbit finding on PR #7488 — the launch-dispatcher event-loop-lag
# regression test must not compare a single uncapped sample against a single
# capped sample taken in a fixed order. JIT warm-up, GC, and CI load can swing
# either single measurement, and the fixed order can make the capped path
# look faster just because the runtime already warmed up.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TARGET="packages/app/src/__tests__/launch-dispatcher-topup-event-loop-lag.test.ts"

echo "Repro: launch-dispatcher event-loop-lag test must use paired, order-alternated samples"

if [ ! -f "$TARGET" ]; then
  echo "[repro] FAIL: missing $TARGET" >&2
  exit 1
fi

if grep -q "PAIRED_SAMPLE_COUNT" "$TARGET" \
  && grep -q "uncappedMedianGapMs" "$TARGET" \
  && grep -q "cappedMedianGapMs" "$TARGET" \
  && grep -q "sample % 2 === 0" "$TARGET"; then
  echo "[repro] PASS: test takes multiple paired samples, alternates measurement order, and compares medians"
  exit 0
fi

echo "[repro] FAIL: test still takes one uncapped sample then one capped sample in a fixed order" >&2
echo "[repro] see CodeRabbit finding on PR #7488" >&2
exit 1
