#!/usr/bin/env bash
# Guard proof for the native PR conflict rebase worker path:
#   1. a DIRTY PR mapped to a workflow at generation g -> "would rebase-recreate"
#   2. once generation g is in the ledger -> "already fired for generation g; skip"
#   3. once the per-workflow attempt cap is reached -> "giving up"
#
# Runs fully offline through `--headless worker pr-conflict-rebase` in dry-run
# with a fake `gh` and a stubbed review-gate resolver; touches only temp state.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-conflict.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

REAL_NODE="$(command -v node)"
WORKER_SOURCE="$ROOT/packages/execution-engine/src/workers/pr-maintenance-workers.ts"
WORKER_RUNNER_SRC="$TMP/run-native-worker.ts"
WORKER_RUNNER_DIR="$TMP/worker-runner-dist"
WORKER_RUNNER="$WORKER_RUNNER_DIR/run-native-worker.mjs"

write_native_worker_runner() {
  mkdir -p "$WORKER_RUNNER_DIR"
  cat > "$WORKER_RUNNER_SRC" <<TS
import { createCoderabbitAddressWorker, createPrConflictRebaseWorker } from '${WORKER_SOURCE}';

const kind = process.argv[2];
const logger = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.log(message),
  error: (message: string) => console.log(message),
  debug: () => {},
  child: () => logger,
};
const factories = {
  'coderabbit-address': createCoderabbitAddressWorker,
  'pr-conflict-rebase': createPrConflictRebaseWorker,
};
const factory = factories[kind as keyof typeof factories];
if (!factory) throw new Error(\`unknown PR-maintenance worker kind: \${kind}\`);
const worker = factory({
  logger,
  repoRoot: process.cwd(),
  lockPath: process.env.INVOKER_PR_CRON_LOCK,
  installSignalHandlers: false,
});
try {
  await worker.tick('manual');
} finally {
  await worker.stop();
}
console.log(\`\${kind} worker scan completed.\`);
TS
  pnpm exec tsup "$WORKER_RUNNER_SRC" --format esm --platform node --out-dir "$WORKER_RUNNER_DIR" >/dev/null
}

run_native_worker() {
  "$REAL_NODE" "$WORKER_RUNNER" "$1" 2>&1
}

write_native_worker_runner

LEDGER="$TMP/ledger.tsv"; : > "$LEDGER"

mkdir -p "$TMP/bin"
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

export PATH="$TMP/bin:$PATH"
export INVOKER_PR_CRON_DRY_RUN=1
export INVOKER_PR_CONFLICT_STATE_FILE="$LEDGER"
export INVOKER_PR_CRON_LOCK="$TMP/crons.lock"
export INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh"

run() { run_native_worker pr-conflict-rebase; }

# Branch 1: fresh ledger -> would rebase-recreate at generation 2.
out="$(INVOKER_TEST_WF_GEN=2 run)"
echo "$out" | grep -q "would rebase-recreate wf-100-1 (generation 2)" \
  || fail "branch 1: expected 'would rebase-recreate ... (generation 2)'" "$out"

# Record generation 2, as a confirmed rebase-recreate would.
printf 'rebase-recreate\twf-100-1\t2\t%s\n' "$(date +%s)" >> "$LEDGER"

# Branch 2: same generation already fired -> skip.
out="$(INVOKER_TEST_WF_GEN=2 run)"
echo "$out" | grep -q "already fired for generation 2; skip" \
  || fail "branch 2: expected 'already fired for generation 2; skip'" "$out"

# Branch 3: reach the cap. The cap is scoped to the CURRENT generation, so seed
# three accepted-dispatch rows for generation 9; that generation is then capped.
printf 'rebase-recreate-attempt\twf-100-1\t9\t%s\n' "$(date +%s)" >> "$LEDGER"
printf 'rebase-recreate-attempt\twf-100-1\t9\t%s\n' "$(date +%s)" >> "$LEDGER"
printf 'rebase-recreate-attempt\twf-100-1\t9\t%s\n' "$(date +%s)" >> "$LEDGER"
out="$(INVOKER_TEST_WF_GEN=9 run)"
echo "$out" | grep -q "giving up" \
  || fail "branch 3: expected 'giving up' at the attempt cap" "$out"

# Branch 4: a genuinely new conflict (generation 10) gets a fresh budget.
out="$(INVOKER_TEST_WF_GEN=10 run)"
echo "$out" | grep -q "would rebase-recreate wf-100-1 (generation 10)" \
  || fail "branch 4: a new generation must get a fresh budget, not stay capped" "$out"

echo "[repro] passed"
