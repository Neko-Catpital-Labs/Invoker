#!/usr/bin/env bash
# Battle-test: the conflict-rebase cron babysits a DIRTY PR end-to-end against
# a fake GitHub — one rebase-recreate dispatch per tick, a hard attempt cap
# when the workflow generation never advances, and exactly one "exhausted"
# PR comment after the cap.
#
# Seams stubbed (no owner process is booted):
#   gh    -> scripts/repro/fixtures/fake-gh/bin/gh serving pr-dirty.json
#   node  -> PATH shim recording the headless-ipc rebase-recreate dispatch
#   resolve_workflow_for_pr -> INVOKER_PR_CRON_REVIEW_GATE_CMD stub whose
#            generation NEVER advances (the workflow is stuck)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-conflict.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home"
export FAKE_GH_STATE_DIR="$TMP/state"
cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/pr-dirty.json" "$FAKE_GH_STATE_DIR/state.json"

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"; : > "$NODE_LOG"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
# Record the accepted headless-ipc dispatch; the owner is not booted here.
printf 'node %s\n' "\$*" >> "$NODE_LOG"
exit 0
EOF
cat > "$TMP/review-gate.sh" <<'RG'
#!/usr/bin/env bash
# Workflow lookup for PR #501; the generation never advances.
printf '{"workflowId":"wf-babysit-1","workflowGeneration":0,"baseBranch":"master"}\n'
RG
chmod +x "$TMP/bin/node" "$TMP/review-gate.sh"

run_cron() {
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_PR_CRON_AUTHOR="fake-bot" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_CONFLICT_STATE_FILE="$TMP/ledger.tsv" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_PR_REBASE_MAX_ATTEMPTS=3 \
  INVOKER_PR_REBASE_CONFIRM_TIMEOUT=0 \
  bash "$ROOT/scripts/cron-pr-conflict-rebase.sh" 2>&1 || true
}

# Ticks 1-3: each dispatches exactly one rebase-recreate for the stuck workflow.
for i in 1 2 3; do
  out="$(run_cron)"
  echo "$out" | grep -q "rebase-recreate wf-babysit-1" \
    || fail "tick $i: expected a rebase-recreate dispatch" "$out"
  dispatches="$(grep -c "exec -- rebase-recreate wf-babysit-1" "$NODE_LOG" || true)"
  [ "$dispatches" -eq "$i" ] \
    || fail "tick $i: expected exactly $i cumulative dispatches, got $dispatches"
done

# Ticks 4-5: cap reached — no new dispatch, one-time exhausted comment posted once.
for i in 4 5; do
  out="$(run_cron)"
  echo "$out" | grep -q "giving up" \
    || fail "tick $i: expected the attempt cap to fire" "$out"
done
dispatches="$(grep -c "exec -- rebase-recreate wf-babysit-1" "$NODE_LOG" || true)"
[ "$dispatches" -eq 3 ] || fail "cap breached: expected 3 dispatches total, got $dispatches"

comments="$(grep -c "^gh pr comment 501" "$FAKE_GH_STATE_DIR/calls.log" || true)"
[ "$comments" -eq 1 ] || fail "expected exactly one exhausted PR comment, got $comments"
grep -q "gave up after 3 rebase-recreate attempts" "$FAKE_GH_STATE_DIR/state.json" \
  || fail "exhausted comment body missing from fake GitHub state"

echo "[repro] passed"
