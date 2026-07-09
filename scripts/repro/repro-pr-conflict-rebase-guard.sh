#!/usr/bin/env bash
# Guard proof for Job 2 via the native `pr-conflict-rebase` worker path:
#   1. a DIRTY PR mapped to a workflow at generation g -> "would rebase-recreate"
#   2. once generation g is in the ledger -> "already fired for generation g; skip"
#   3. once the per-workflow attempt cap is reached -> "giving up"
#
# Runs fully offline in dry-run with a fake `gh` and a stubbed review-gate
# resolver served through the worker's prMaintenance config; touches only temp
# ledger/lock files.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-conflict.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

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

WORKER_CONFIG="$TMP/pr-maintenance-config.json"
WORKER_RUNNER="$TMP/run-pr-maintenance-worker.mjs"
WORKER_LOADER="$TMP/ts-js-loader.mjs"

cat > "$WORKER_LOADER" <<'NODE'
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.endsWith('.js')) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw err;
  }
}
NODE

cat > "$WORKER_RUNNER" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [kind, configPath, repoRoot] = process.argv.slice(2);
const engine = await import(pathToFileURL(
  `${repoRoot}/packages/execution-engine/src/workers/pr-maintenance-workers.ts`,
).href);
const config = JSON.parse(readFileSync(configPath, 'utf8')).prMaintenance;
const logger = {
  info(message) { console.log(message); },
  warn(message) { console.error(message); },
  error(message) { console.error(message); },
  debug() {},
  child() { return this; },
};
const worker = kind === 'coderabbit-address'
  ? engine.createCoderabbitAddressWorker({ logger, ...config, installSignalHandlers: false })
  : engine.createPrConflictRebaseWorker({ logger, ...config, installSignalHandlers: false });
try {
  await worker.tick('manual');
  await worker.stop();
  console.log(`${kind} worker scan completed.`);
} catch (err) {
  await worker.stop();
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
NODE

jq -n \
  --arg repoRoot "$ROOT" \
  --arg lock "$TMP/crons.lock" \
  --arg path "$TMP/bin:$PATH" \
  --arg ledger "$LEDGER" \
  --arg reviewGate "$TMP/review-gate.sh" \
  '{
    enabled: true,
    repoRoot: $repoRoot,
    lockPath: $lock,
    env: {
      PATH: $path,
      INVOKER_PR_CRON_DRY_RUN: "1",
      INVOKER_PR_CONFLICT_STATE_FILE: $ledger,
      INVOKER_PR_CRON_REVIEW_GATE_CMD: $reviewGate
    }
  } | { prMaintenance: . }' > "$WORKER_CONFIG"

run() {
  NODE_NO_WARNINGS=1 node --loader "$WORKER_LOADER" "$WORKER_RUNNER" pr-conflict-rebase "$WORKER_CONFIG" "$ROOT" 2>&1
}

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
