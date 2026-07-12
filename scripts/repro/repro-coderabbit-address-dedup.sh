#!/usr/bin/env bash
# Dedup proof for the native CodeRabbit PR-maintenance worker path:
#   1. a PR with a coderabbitai[bot] comment updated at T -> "would launch omp ... at T"
#   2. once T is in the ledger -> "no new CodeRabbit comments since T; skip"
#   3. a newer comment T2 -> "would launch omp ... at T2" again
#   4. once the per-PR attempt cap is reached -> "hit cap"
#
# Runs fully offline through `--headless worker coderabbit-address` in dry-run
# with a fake `gh` serving captured comment JSON; touches only temp state.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-coderabbit.XXXXXX")"
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

export PATH="$TMP/bin:$PATH"
export INVOKER_PR_CRON_DRY_RUN=1
export INVOKER_PR_CODERABBIT_STATE_FILE="$LEDGER"
export INVOKER_PR_CRON_LOCK="$TMP/crons.lock"

run() { run_native_worker coderabbit-address; }

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
