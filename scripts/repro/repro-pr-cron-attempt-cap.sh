#!/usr/bin/env bash
# End-to-end proof that the PR cron jobs cannot retry a failing operation
# forever (CodeRabbit findings: count attempts, not just successes).
#
# Before the fix both jobs only recorded SUCCESS markers, so a failed omp run
# (Job 1) or an accepted-but-unconfirmed rebase-recreate (Job 2) recorded
# nothing and re-fired every tick indefinitely. The fix records an attempt on
# every real try and caps on that ledger.
#
# This drives the native worker REAL (non-dry) failure paths offline with fakes:
#   Job 2: fake `node` accepts the dispatch; CONFIRM_TIMEOUT=0 means it never
#          confirms -> each run records one rebase-recreate-attempt and exits 1.
#   Job 1: fake `gh repo clone` fails -> prepare_checkout fails after the
#          attempt is recorded -> each run records one coderabbit-attempt, exits 1.
# After MAX attempts the next worker run hits the cap instead of dispatching again.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-attempt-cap.XXXXXX")"
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

mkdir -p "$TMP/bin"

# ---------------------------------------------------------------------------
# Job 2 — rebase-recreate accepted but never confirmed.
# ---------------------------------------------------------------------------
cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "list" ]; then
  printf '%s\n' '[{"number":555,"headRefName":"h","mergeable":"CONFLICTING","mergeStateStatus":"DIRTY"}]'
  exit 0
fi
if [ "${1:-}" = "pr" ] && [ "${2:-}" = "comment" ]; then exit 0; fi
echo "fake gh: unhandled: $*" >&2; exit 1
GH
cat > "$TMP/bin/node" <<'NODE'
#!/usr/bin/env bash
# Accept the rebase-recreate dispatch (node "$IPC_HELPER" exec -- rebase-recreate <wf>).
exit 0
NODE
cat > "$TMP/review-gate.sh" <<'RG'
#!/usr/bin/env bash
printf '{"workflowId":"wf-cap-2","workflowGeneration":0,"baseBranch":"main"}\n'
RG
chmod +x "$TMP/bin/gh" "$TMP/bin/node" "$TMP/review-gate.sh"

J2_LEDGER="$TMP/j2.tsv"; : > "$J2_LEDGER"
run_job2() {
  PATH="$TMP/bin:$PATH" \
  INVOKER_PR_CRON_DRY_RUN=0 \
  INVOKER_PR_CONFLICT_STATE_FILE="$J2_LEDGER" \
  INVOKER_PR_CRON_LOCK="$TMP/j2.lock" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_PR_REBASE_CONFIRM_TIMEOUT=0 \
  run_native_worker pr-conflict-rebase
}

for i in 1 2 3; do
  out="$(run_job2 || true)"
  echo "$out" | grep -q "not confirmed" \
    || fail "Job 2 run $i: expected an unconfirmed dispatch" "$out"
done
n="$(awk -F'\t' '$1=="rebase-recreate-attempt" && $2=="wf-cap-2"{c++} END{print c+0}' "$J2_LEDGER")"
[ "$n" -eq 3 ] || fail "Job 2: expected 3 recorded attempts, got $n"

out="$(run_job2 || true)"
echo "$out" | grep -q "giving up" \
  || fail "Job 2: 4th run must hit the cap (giving up), not dispatch again" "$out"

# ---------------------------------------------------------------------------
# Job 1 — omp attempt fails (clone fails) but the attempt is still counted.
# ---------------------------------------------------------------------------
cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
case "${1:-}" in
  pr)
    case "${2:-}" in
      list) printf '%s\n' '[{"number":556,"url":"https://github.com/o/r/pull/556","headRefName":"h","baseRefName":"main","title":"t"}]'; exit 0;;
      view) printf '%s\n' '{"title":"t","body":"b","headRefName":"h","baseRefName":"main"}'; exit 0;;
    esac;;
  api)
    case "${2:-}" in
      */pulls/*/comments) printf '%s\n' '[{"user":{"login":"coderabbitai[bot]"},"body":"x","updated_at":"2026-06-25T10:00:00Z"}]'; exit 0;;
      */issues/*/comments) printf '[]\n'; exit 0;;
    esac;;
  repo)
    # Force prepare_checkout to fail AFTER the attempt has been recorded.
    [ "${2:-}" = "clone" ] && exit 1;;
esac
echo "fake gh: unhandled: $*" >&2; exit 1
GH
chmod +x "$TMP/bin/gh"

# Job 1's task context is irrelevant to the attempt cap; return an empty result
# so launch_omp skips the (real) tasks query and stays fully offline.
cat > "$TMP/review-gate-empty.sh" <<'RG'
#!/usr/bin/env bash
printf '{}\n'
RG
chmod +x "$TMP/review-gate-empty.sh"

J1_LEDGER="$TMP/j1.tsv"; : > "$J1_LEDGER"
run_job1() {
  PATH="$TMP/bin:$PATH" \
  INVOKER_PR_CRON_DRY_RUN=0 \
  INVOKER_PR_CODERABBIT_STATE_FILE="$J1_LEDGER" \
  INVOKER_PR_CRON_LOCK="$TMP/j1.lock" \
  INVOKER_PR_CRON_WORKDIR="$TMP/work" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate-empty.sh" \
  run_native_worker coderabbit-address
}

for i in 1 2 3; do
  out="$(run_job1 || true)"
  echo "$out" | grep -q "clone failed" \
    || fail "Job 1 run $i: expected the omp checkout to fail" "$out"
done
n="$(awk -F'\t' '$1=="coderabbit-attempt" && $2=="556"{c++} END{print c+0}' "$J1_LEDGER")"
[ "$n" -eq 3 ] || fail "Job 1: expected 3 recorded attempts, got $n"

out="$(run_job1 || true)"
echo "$out" | grep -q "hit cap" \
  || fail "Job 1: 4th run must hit the cap, not attempt again" "$out"

echo "[repro] passed"
