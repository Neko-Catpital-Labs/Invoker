#!/usr/bin/env bash
set -euo pipefail

# The pr-admin-bypass-land worker (packages/execution-engine/src/workers/
# pr-maintenance-workers.ts) force-kills the whole babysitting script if a
# single tick runs past its 240s timeout (DEFAULT_PR_MAINTENANCE_WORKER_TICK_
# TIMEOUT_MS). A real cycle makes 100+ `gh` calls for ~50 admin-bypass PRs.
#
# The first fix for the transient-gh-failure bug (see
# repro-mergify-admin-requeue-transient-gh-failure.sh) gave run_logged() a
# 90s per-call timeout with 3 retries -- but never checked that budget
# against the worker's own 240s ceiling. Worst case for ONE stuck call alone
# was 276s: bigger than the worker's entire tick timeout. A single hung call
# could make the worker kill the script even faster/worse than before the
# fix, and still get zero useful work done.
#
# This proves it two ways:
#   1. With the original 90s/3-attempt budget: the worst case for one call
#      exceeds the worker's 240s tick timeout. FAIL.
#   2. With the current working tree's tightened budget: the worst case for
#      one call stays under a safe fraction of the tick timeout, leaving
#      room for the other 100+ calls in the same cycle. PASS.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

WORKER_TICK_TIMEOUT_SECONDS=240

fail() {
  echo "[repro] FAIL: $1"
  exit 1
}

worst_case_seconds() {
  python3 -c "
timeout, attempts, backoff = $1, $2, $3
worst = 0
for attempt in range(1, attempts + 1):
    worst += timeout
    if attempt < attempts:
        worst += backoff * attempt
print(worst)
"
}

echo "[repro] === BEFORE: original run_logged budget (90s timeout, 3 attempts, 2s backoff step) ==="
BEFORE=$(worst_case_seconds 90 3 2)
echo "[repro] worst case for one stuck gh call: ${BEFORE}s (worker tick timeout: ${WORKER_TICK_TIMEOUT_SECONDS}s)"
if [ "$BEFORE" -lt "$WORKER_TICK_TIMEOUT_SECONDS" ]; then
  fail "expected the original budget to exceed the worker's tick timeout, but it didn't (${BEFORE}s < ${WORKER_TICK_TIMEOUT_SECONDS}s)"
fi
echo "[repro] confirmed: one stuck call alone could burn the worker's whole tick budget (${BEFORE}s >= ${WORKER_TICK_TIMEOUT_SECONDS}s)"
echo

echo "[repro] === AFTER: current working tree's tightened budget ==="
ACTUAL=$(python3 -c "
import sys
sys.path.insert(0, 'scripts')
import mergify_admin_requeue_snapshot as s
print(s.GH_CALL_WORST_CASE_SECONDS)
")
SAFE_CEILING=$((WORKER_TICK_TIMEOUT_SECONDS / 3))
echo "[repro] worst case for one stuck gh call: ${ACTUAL}s (safe ceiling: ${SAFE_CEILING}s, 1/3 of tick timeout)"
if [ "$ACTUAL" -ge "$SAFE_CEILING" ]; then
  fail "current budget (${ACTUAL}s) does not leave enough headroom under the worker's tick timeout (ceiling ${SAFE_CEILING}s)"
fi
echo "[repro] confirmed: one stuck call now leaves headroom for the other 100+ calls in the same tick"
echo
echo "[repro] PASS: worker-tick-budget repro reproduced the risk in the original retry fix and confirmed the correction"
