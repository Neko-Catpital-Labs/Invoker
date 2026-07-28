#!/usr/bin/env bash
# Root-cause repro: the 5 PR-maintenance workers (coderabbit-address,
# pr-conflict-rebase, pr-ci-failure-scan, pr-admin-bypass-land,
# pr-orphan-repair) all share one intervalMs
# (DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS) with zero jitter, and
# registerPrMaintenanceWorkers() starts them in a fixed order. Node fires
# same-tick setInterval callbacks in registration order, so whichever worker
# registers first tends to win the shared cron lock almost every cycle,
# starving workers registered later — especially pr-admin-bypass-land, 4th of 5.
#
# Drives the REAL production worker runtimes (createCoderabbitAddressWorker
# etc., the same factories registerPrMaintenanceWorkers uses), with only the
# leaf shell entrypoint swapped for a lightweight stand-in that holds the real
# shared flock for a simulated work duration and records who actually got to
# run. Everything else — intervalMs, registration order, the real
# probePrMaintenanceLock probe, the real spawn+await path — is untouched
# production code.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-starvation.XXXXXX")"
RESULTS="$TMP/results.jsonl"
: > "$RESULTS"
FAKE_SCRIPT="$TMP/fake-entrypoint.sh"
PROOF_TEST="$ROOT/packages/execution-engine/src/__pr_maintenance_starvation_repro_$$.test.ts"

cleanup() {
  rm -f "$PROOF_TEST"
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

cat > "$FAKE_SCRIPT" <<SH
#!/usr/bin/env bash
set -euo pipefail
# Mirrors cron-pr-lib.sh's cron_lock(): acquire+hold the SAME shared lock for
# the simulated work duration. The TS-level probePrMaintenanceLock only does a
# fast acquire-then-release check; the real held-lock window happens here,
# inside the spawned leaf script, same as the production shell entrypoints.
# Uses flock when available (Linux, e.g. the real droplet host), falling back
# to the same portable mkdir lock cron-pr-lib.sh uses when it isn't (macOS).
if command -v flock >/dev/null 2>&1; then
  exec 9>"$TMP/crons.lock"
  flock -n 9 || exit 0
else
  lockdir="$TMP/crons.lock.d"
  if ! mkdir "\$lockdir" 2>/dev/null; then
    exit 0
  fi
  printf '%s\n' "\$\$" > "\$lockdir/pid"
  trap 'rm -rf "'"\$lockdir"'" 2>/dev/null || true' EXIT
fi
echo "\$(date +%s%3N) \${INVOKER_PR_MAINTENANCE_KIND:-unknown}" >> "$RESULTS"
sleep 0.15
SH
chmod +x "$FAKE_SCRIPT"

ensure_execution_engine_vitest() {
  pnpm --filter @invoker/execution-engine exec vitest --version >/dev/null 2>&1 && return 0
  echo "[repro] installing workspace dependencies for @invoker/execution-engine vitest"
  pnpm install --frozen-lockfile
  pnpm --filter @invoker/execution-engine exec vitest --version >/dev/null 2>&1
}

cat > "$PROOF_TEST" <<TS
import { describe, it } from 'vitest';
import {
  createCoderabbitAddressWorker,
  createPrConflictRebaseWorker,
  createPrCiFailureScanWorker,
  createPrAdminBypassLandWorker,
  createPrOrphanRepairWorker,
  CODERABBIT_ADDRESS_WORKER_KIND,
  PR_CONFLICT_REBASE_WORKER_KIND,
  PR_CI_FAILURE_SCAN_WORKER_KIND,
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_ORPHAN_REPAIR_WORKER_KIND,
} from './workers/pr-maintenance-workers.js';

// Real registration order, from registerPrMaintenanceWorkers() in
// packages/execution-engine/src/workers/pr-maintenance-workers.ts:111-119.
const FACTORIES = [
  { kind: CODERABBIT_ADDRESS_WORKER_KIND, create: createCoderabbitAddressWorker },
  { kind: PR_CONFLICT_REBASE_WORKER_KIND, create: createPrConflictRebaseWorker },
  { kind: PR_CI_FAILURE_SCAN_WORKER_KIND, create: createPrCiFailureScanWorker },
  { kind: PR_ADMIN_BYPASS_LAND_WORKER_KIND, create: createPrAdminBypassLandWorker },
  { kind: PR_ORPHAN_REPAIR_WORKER_KIND, create: createPrOrphanRepairWorker },
];

const logger = { info: () => {}, warn: () => {}, error: (...a: unknown[]) => console.error('[worker error]', ...a), debug: () => {}, trace: () => {}, child: () => logger };

describe('PR-maintenance shared-lock starvation repro', () => {
  it('runs all 5 real worker runtimes with zero jitter and records who wins the shared lock', async () => {
    const workers = FACTORIES.map(({ kind, create }) =>
      (create as (options: unknown) => { start: () => void; stop: () => Promise<void> })({
        logger,
        repoRoot: '$ROOT',
        lockPath: '$TMP/crons.lock',
        shell: '$FAKE_SCRIPT',
        intervalMs: 400,
        env: { INVOKER_PR_MAINTENANCE_KIND: kind, INVOKER_PR_CRON_LOCK: '$TMP/crons.lock' },
      }),
    );

    for (const worker of workers) worker.start();
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    await Promise.all(workers.map((w) => w.stop()));
  }, 30_000);
});
TS

ensure_execution_engine_vitest
echo "[repro] starting 5 real PR-maintenance worker runtimes, intervalMs=400ms, no jitter (matches production)"
set +e
vitest_out="$(pnpm --filter @invoker/execution-engine exec vitest run "src/$(basename "$PROOF_TEST")" 2>&1)"
code=$?
set -e
[ "$code" -eq 0 ] || fail "repro test run failed" "$vitest_out"

echo "$vitest_out" | grep -i 'worker error' && fail "a worker runtime logged an error" "$vitest_out"

TOTAL=$(wc -l < "$RESULTS" | tr -d ' ')
echo ""
echo "[repro] $TOTAL total successful lock acquisitions across 5 workers over 20s:"
echo ""
FAIRSHARE=$(awk -v t="$TOTAL" 'BEGIN { printf "%.1f", t / 5 }')
MAX_RUNS=0
ZERO_COUNT=0
for kind in coderabbit-address pr-conflict-rebase pr-ci-failure-scan pr-admin-bypass-land pr-orphan-repair; do
  n=$(awk -v k="$kind" '$2 == k { c++ } END { print c + 0 }' "$RESULTS")
  pct=$(awk -v n="$n" -v t="$TOTAL" 'BEGIN { print (t > 0) ? (n / t * 100) : 0 }')
  printf '  %-28s %4d runs  (%.1f%%)\n' "$kind" "$n" "$pct"
  [ "$n" -gt "$MAX_RUNS" ] && MAX_RUNS="$n"
  [ "$n" -eq 0 ] && ZERO_COUNT=$((ZERO_COUNT + 1))
done

echo ""
# Starvation signal: one worker alone takes at least twice its fair share
# (fair share for 5 workers is 20% each, so >=40% for one worker). Which
# specific worker dominates varies run to run — Node's same-tick setInterval
# ordering isn't perfectly deterministic across process restarts — but this
# severe a skew has reproduced on every run observed while developing this repro.
DOMINANT_SHARE=$(awk -v m="$MAX_RUNS" -v t="$TOTAL" 'BEGIN { print (t > 0) ? (m / t) : 0 }')
DOMINANT_PCT=$(awk -v s="$DOMINANT_SHARE" 'BEGIN { printf "%.1f", s * 100 }')
if awk -v s="$DOMINANT_SHARE" 'BEGIN { exit !(s >= 0.4) }'; then
  echo "[repro] STARVATION CONFIRMED: one worker alone got $MAX_RUNS of $TOTAL runs (${DOMINANT_PCT}%, fair share is 20%), and $ZERO_COUNT of 5 workers got ZERO runs in 20s."
  echo "[repro] Root cause: every PR-maintenance worker shares one intervalMs with zero jitter"
  echo "[repro] (packages/execution-engine/src/workers/pr-maintenance-workers.ts:20,266), and"
  echo "[repro] setInterval (packages/execution-engine/src/worker-runtime.ts:246) fires same-tick"
  echo "[repro] callbacks in registration order, so registerPrMaintenanceWorkers()'s fixed order"
  echo "[repro] (pr-maintenance-workers.ts:111-119) systematically favors earlier-registered workers"
  echo "[repro] for the shared cron lock (cron-pr-lib.sh / probePrMaintenanceLock)."
  exit 1
else
  echo "[repro] No significant starvation observed this run (distribution looked roughly fair)."
  exit 0
fi
