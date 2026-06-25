#!/usr/bin/env bash
# Guard proof for Job 2 (scripts/cron-pr-conflict-rebase.sh):
#   1. a DIRTY PR mapped to a workflow at generation g -> "would rebase-recreate"
#   2. once generation g is in the ledger -> "already fired for generation g; skip"
#   3. once the per-workflow attempt cap is reached -> "giving up"
#
# Runs fully offline in dry-run with a fake `gh` and a stubbed review-gate
# resolver; touches only a temp ledger/lock.
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

export PATH="$TMP/bin:$PATH"
export INVOKER_PR_CRON_DRY_RUN=1
export INVOKER_PR_CONFLICT_STATE_FILE="$LEDGER"
export INVOKER_PR_CRON_LOCK="$TMP/crons.lock"
export INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh"

run() { bash scripts/cron-pr-conflict-rebase.sh 2>&1; }

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

# Branch 3: reach the cap (3 recorded attempts), new generation 9 -> giving up.
printf 'rebase-recreate\twf-100-1\t0\t%s\n' "$(date +%s)" >> "$LEDGER"
printf 'rebase-recreate\twf-100-1\t1\t%s\n' "$(date +%s)" >> "$LEDGER"
out="$(INVOKER_TEST_WF_GEN=9 run)"
echo "$out" | grep -q "giving up" \
  || fail "branch 3: expected 'giving up' at the attempt cap" "$out"

echo "[repro] passed"
