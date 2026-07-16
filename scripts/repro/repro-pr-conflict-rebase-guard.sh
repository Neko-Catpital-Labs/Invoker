#!/usr/bin/env bash
# Guard proof for the native pr-conflict-rebase worker path:
#   1. a DIRTY PR mapped to a workflow at generation g -> "would rebase-recreate"
#   2. once generation g is in the ledger -> "already fired for generation g; skip"
#   3. once the per-workflow attempt cap is reached -> "giving up"
#
# Runs fully offline through `./run.sh --headless worker pr-conflict-rebase`
# with a fake `gh` and a stubbed review-gate resolver; touches only temp state.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-conflict.XXXXXX")"
WORKER_PROOF_TEST="$ROOT/packages/execution-engine/src/__pr_maintenance_repro_$$.test.ts"
cleanup() {
  rm -f "$WORKER_PROOF_TEST"
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

VITEST_READY=0
ensure_execution_engine_vitest() {
  [ "$VITEST_READY" -eq 1 ] && return 0
  if pnpm --filter @invoker/execution-engine exec vitest --version >/dev/null 2>&1; then
    VITEST_READY=1
    return 0
  fi
  echo "[repro] installing workspace dependencies for @invoker/execution-engine vitest"
  pnpm install --frozen-lockfile || return $?
  pnpm --filter @invoker/execution-engine exec vitest --version >/dev/null 2>&1 || return $?
  VITEST_READY=1
}

write_worker_proof_test() {
  cat > "$WORKER_PROOF_TEST" <<'TS'
import { describe, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { createCoderabbitAddressWorker, createPrConflictRebaseWorker } from './workers/pr-maintenance-workers.js';

const logPath = process.env.REPRO_PR_MAINTENANCE_LOG;
const log = (message: unknown): void => {
  if (logPath) appendFileSync(logPath, `${String(message)}\n`);
};
const logger = { info: log, warn: log, error: log, debug: () => {}, trace: () => {}, child: () => logger };
const rawConfig = JSON.parse(process.env.REPRO_PR_MAINTENANCE_CONFIG ?? '{}');
const prMaintenance = rawConfig.prMaintenance ?? rawConfig;
delete prMaintenance.enabled;

describe('native PR-maintenance repro worker', () => {
  it('runs one tick', async () => {
    const options = { logger, ...prMaintenance };
    const worker = process.env.REPRO_PR_MAINTENANCE_WORKER === 'coderabbit-address'
      ? createCoderabbitAddressWorker(options as never)
      : createPrConflictRebaseWorker(options as never);
    await worker.tick('manual');
    await worker.stop();
  });
});
TS
}

run_native_worker() {
  local worker="$1" config="$2"
  local log="$TMP/native-worker.log"
  local vitest_out code
  ensure_execution_engine_vitest
  write_worker_proof_test
  : > "$log"
  set +e
  vitest_out="$(REPRO_PR_MAINTENANCE_WORKER="$worker" REPRO_PR_MAINTENANCE_CONFIG="$(cat "$config")" REPRO_PR_MAINTENANCE_LOG="$log" pnpm --filter @invoker/execution-engine exec vitest run "src/$(basename "$WORKER_PROOF_TEST")" 2>&1)"
  code=$?
  set -e
  cat "$log"
  printf '%s\n' "$vitest_out"
  return "$code"
}

LEDGER="$TMP/ledger.tsv"; : > "$LEDGER"
CONFIG="$TMP/config.json"

mkdir -p "$TMP/bin" "$TMP/home"
cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
# Job 2 only calls `gh pr list ...` in dry-run.
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "list" ]; then
  printf '%s\n' '[{"number":501,"headRefName":"stack/edbert/plan/x--abc","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}]'
  exit 0
fi
echo "fake gh: unhandled: $*" >&2
exit 1
GH
chmod +x "$TMP/bin/gh"

cat > "$TMP/review-gate.sh" <<'RG'
#!/usr/bin/env bash
pr="$1"
gen="${INVOKER_TEST_WF_GEN:-2}"
printf '{"workflowId":"wf-100-1","workflowGeneration":%s,"mergeTaskId":"__merge__wf-100-1","reviewId":"%s","workflowStatus":"running","baseBranch":"main"}\n' "$gen" "$pr"
RG
chmod +x "$TMP/review-gate.sh"

cat > "$CONFIG" <<EOF
{"prMaintenance":{"enabled":true,"repoRoot":"$ROOT","lockPath":"$TMP/crons.lock","env":{"PATH":"$TMP/bin:$PATH","INVOKER_PR_CRON_DRY_RUN":"1","INVOKER_PR_CONFLICT_STATE_FILE":"$LEDGER","INVOKER_PR_CRON_LOCK":"$TMP/crons.lock","INVOKER_PR_CRON_REVIEW_GATE_CMD":"$TMP/review-gate.sh"}}}
EOF

run() { run_native_worker pr-conflict-rebase "$CONFIG"; }

# Branch 1: fresh ledger -> would rebase-recreate at generation 2.
set +e
out="$(INVOKER_TEST_WF_GEN=2 run)"
code=$?
set -e
[ "$code" -eq 0 ] || fail "branch 1: native worker exited $code" "$out"
echo "$out" | grep -q "would rebase-recreate wf-100-1 (generation 2)" \
  || fail "branch 1: expected 'would rebase-recreate ... (generation 2)'" "$out"

# Record generation 2, as a confirmed rebase-recreate would.
printf 'rebase-recreate\twf-100-1\t2\t%s\n' "$(date +%s)" >> "$LEDGER"

# Branch 2: same generation already fired -> skip.
set +e
out="$(INVOKER_TEST_WF_GEN=2 run)"
code=$?
set -e
[ "$code" -eq 0 ] || fail "branch 2: native worker exited $code" "$out"
echo "$out" | grep -q "already fired for generation 2; skip" \
  || fail "branch 2: expected 'already fired for generation 2; skip'" "$out"

# Branch 3: reach the cap. The cap is scoped to the CURRENT generation, so seed
# three accepted-dispatch rows for generation 9; that generation is then capped.
printf 'rebase-recreate-attempt\twf-100-1\t9\t%s\n' "$(date +%s)" >> "$LEDGER"
printf 'rebase-recreate-attempt\twf-100-1\t9\t%s\n' "$(date +%s)" >> "$LEDGER"
printf 'rebase-recreate-attempt\twf-100-1\t9\t%s\n' "$(date +%s)" >> "$LEDGER"
set +e
out="$(INVOKER_TEST_WF_GEN=9 run)"
code=$?
set -e
[ "$code" -eq 0 ] || fail "branch 3: native worker exited $code" "$out"
echo "$out" | grep -q "giving up" \
  || fail "branch 3: expected 'giving up' at the attempt cap" "$out"

# Branch 4: a genuinely new conflict (generation 10) gets a fresh budget.
set +e
out="$(INVOKER_TEST_WF_GEN=10 run)"
code=$?
set -e
[ "$code" -eq 0 ] || fail "branch 4: native worker exited $code" "$out"
echo "$out" | grep -q "would rebase-recreate wf-100-1 (generation 10)" \
  || fail "branch 4: a new generation must get a fresh budget, not stay capped" "$out"

echo "[repro] passed"
