#!/usr/bin/env bash
# Dedup proof for the native coderabbit-address worker path:
#   1. a PR with a coderabbitai[bot] comment updated at T -> "would launch omp ... at T"
#   2. once T is in the ledger -> "no new CodeRabbit comments since T; skip"
#   3. a newer comment T2 -> "would launch omp ... at T2" again
#   4. once the per-PR attempt cap is reached -> "hit cap"
#
# Runs fully offline through `./run.sh --headless worker coderabbit-address`
# with a fake `gh` serving captured comment JSON; touches only temp state.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-coderabbit.XXXXXX")"
WORKER_PROOF_TEST="$ROOT/packages/execution-engine/src/__pr_maintenance_repro_$$.test.ts"
cleanup() {
  rm -f "$WORKER_PROOF_TEST"
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

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
case "${1:-}" in
  pr)
    if [ "${2:-}" = "list" ]; then
      printf '%s\n' '[{"number":777,"url":"https://github.com/owner/repo/pull/777","headRefName":"h","baseRefName":"main","title":"t"}]'
      exit 0
    fi
    ;;
  api)
    case "${2:-}" in
      */pulls/*/comments)
        printf '[{"user":{"login":"coderabbitai[bot]"},"body":"please fix X","updated_at":"%s","path":"a.ts","html_url":"u"}]\n' "${INVOKER_TEST_CR_UPDATED:?}"
        exit 0 ;;
      */issues/*/comments)
        printf '[]\n'; exit 0 ;;
    esac
    ;;
esac
echo "fake gh: unhandled: $*" >&2
exit 1
GH
chmod +x "$TMP/bin/gh"

cat > "$CONFIG" <<EOF
{"prMaintenance":{"enabled":true,"repoRoot":"$ROOT","lockPath":"$TMP/crons.lock","env":{"PATH":"$TMP/bin:$PATH","INVOKER_PR_CRON_DRY_RUN":"1","INVOKER_PR_CODERABBIT_STATE_FILE":"$LEDGER","INVOKER_PR_CRON_LOCK":"$TMP/crons.lock"}}}
EOF

run() { run_native_worker coderabbit-address "$CONFIG"; }

T1="2026-06-25T08:00:00Z"
T2="2026-06-25T09:30:00Z"
T3="2026-06-25T11:45:00Z"

# Check 1: new feedback at T1 -> would launch omp.
out="$(INVOKER_TEST_CR_UPDATED="$T1" run)"
echo "$out" | grep -q "would launch omp for new CodeRabbit activity at $T1" \
  || fail "check 1: expected 'would launch omp ... at $T1'" "$out"

# Record marker T1, as a successful omp run would.
printf 'coderabbit\t777\t%s\t%s\n' "$T1" "$(date +%s)" >> "$LEDGER"

# Check 2: same latest T1 -> skip.
out="$(INVOKER_TEST_CR_UPDATED="$T1" run)"
echo "$out" | grep -q "no new CodeRabbit comments since $T1; skip" \
  || fail "check 2: expected 'no new CodeRabbit comments since $T1; skip'" "$out"

# Check 3: newer T2 -> would launch again.
out="$(INVOKER_TEST_CR_UPDATED="$T2" run)"
echo "$out" | grep -q "would launch omp for new CodeRabbit activity at $T2" \
  || fail "check 3: expected 'would launch omp ... at $T2'" "$out"

# Check 4: reach the cap. The cap is scoped to the CURRENT comment marker, so
# seed three attempt rows for T3; that exact batch is then capped.
printf 'coderabbit-attempt\t777\t%s\t%s\n' "$T3" "$(date +%s)" >> "$LEDGER"
printf 'coderabbit-attempt\t777\t%s\t%s\n' "$T3" "$(date +%s)" >> "$LEDGER"
printf 'coderabbit-attempt\t777\t%s\t%s\n' "$T3" "$(date +%s)" >> "$LEDGER"
out="$(INVOKER_TEST_CR_UPDATED="$T3" run)"
echo "$out" | grep -q "hit cap" \
  || fail "check 4: expected 'hit cap' at the per-batch attempt cap" "$out"

# Check 5: a NEWER comment T4 gets a fresh budget (cap is per-batch, not per-PR).
T4="2026-06-25T12:00:00Z"
out="$(INVOKER_TEST_CR_UPDATED="$T4" run)"
echo "$out" | grep -q "would launch omp for new CodeRabbit activity at $T4" \
  || fail "check 5: newer feedback T4 must get a fresh budget, not stay capped" "$out"

echo "[repro] passed"
