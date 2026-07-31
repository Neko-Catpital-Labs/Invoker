#!/usr/bin/env bash
# Battle-test: scripts/cron-admin-bypass-queue.sh scans admin-bypass-labeled
# PRs ONCE, classifies each, and submits ONE fast task per PR (never runs
# repair work itself) against a fake GitHub (pr-admin-bypass-queue.json):
#   #901 mapped,   conflict           -> rebase-recreate wf-mapped-901
#   #902 unmapped, failed checks      -> ad-hoc repair plan via `run`
#   #903 mapped,   changes_requested  -> ad-hoc repair plan via `run` (no dedicated mutation)
#   #904 mapped,   clean              -> skipped, no blocker
#   #905 broken but NOT admin-bypass labeled -> excluded by --label filter
#   #906 admin-bypass, draft          -> skipped
# Then: same tick again -> fingerprint dedup, no re-submission.
# Then: attempt cap -> one-time exhausted PR comment.
# Then: DRY_RUN=1 -> logs the route, submits nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-admin-bypass-queue.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home" "$TMP/plans"
export FAKE_GH_STATE_DIR="$TMP/state"
cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/pr-admin-bypass-queue.json" "$FAKE_GH_STATE_DIR/state.json"

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"; : > "$NODE_LOG"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node env require=%s args=%s\n' "\${INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER:-}" "\$*" >> "$NODE_LOG"
if [ "\${FAKE_NODE_FAIL:-0}" = "1" ]; then
  echo "simulated ipc failure" >&2
  exit 42
fi
exit 0
EOF
chmod +x "$TMP/bin/node"

# Review-gate stub: #901 and #903 are mapped, everything else is a clean miss.
cat > "$TMP/review-gate.sh" <<'RG'
#!/usr/bin/env bash
case "${1:-}" in
  901) printf '{"workflowId":"wf-mapped-901","workflowGeneration":2,"baseBranch":"master"}\n' ;;
  903) printf '{"workflowId":"wf-mapped-903","workflowGeneration":1,"baseBranch":"master"}\n' ;;
  *) printf '{}\n' ;;
esac
RG
chmod +x "$TMP/review-gate.sh"

run_cron() {
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_ADMIN_BYPASS_QUEUE_STATE_FILE="$TMP/ledger.tsv" \
  INVOKER_ADMIN_BYPASS_QUEUE_PLAN_DIR="$TMP/plans" \
  INVOKER_ADMIN_BYPASS_QUEUE_MAX_ATTEMPTS=3 \
  "$@" \
  bash "$ROOT/scripts/cron-admin-bypass-queue.sh" 2>&1
}

# Tick 1.
out="$(run_cron)" || fail "tick 1 exited non-zero" "$out"

echo "$out" | grep -q "PR #901: submitted rebase-recreate for workflow wf-mapped-901" \
  || fail "tick 1: expected rebase-recreate for mapped conflict #901" "$out"
echo "$out" | grep -q "PR #902: submitted ad-hoc repair plan (category=failed_checks" \
  || fail "tick 1: expected ad-hoc plan for unmapped failed_checks #902" "$out"
echo "$out" | grep -q "PR #903: submitted ad-hoc repair plan (category=changes_requested" \
  || fail "tick 1: expected ad-hoc plan for mapped changes_requested #903 (no dedicated mutation)" "$out"
echo "$out" | grep -q "PR #904: no actionable blocker found; skipping" \
  || fail "tick 1: expected #904 (clean) to be skipped" "$out"
echo "$out" | grep -q "PR #905" \
  && fail "tick 1: #905 is not admin-bypass labeled and must never appear" "$out"
echo "$out" | grep -q "PR #906: draft; skipping" \
  || fail "tick 1: expected draft #906 to be skipped" "$out"

# rebase-recreate must never be routed for a non-conflict category, and
# repair-review-gate-ci must never fire here (no mapped failed_checks PR in
# this scenario). Assert the exact node call shape landed.
grep -q "exec --no-track -- rebase-recreate wf-mapped-901" "$NODE_LOG" \
  || fail "tick 1: rebase-recreate wf-mapped-901 not dispatched" "$(cat "$NODE_LOG")"
grep -q "require=1" "$NODE_LOG" \
  || fail "tick 1: worker IPC dispatch must require an existing owner" "$(cat "$NODE_LOG")"
runs="$(grep -c "exec --no-track -- run " "$NODE_LOG" || true)"
[ "$runs" -eq 2 ] || fail "tick 1: expected exactly 2 ad-hoc plan submissions, got $runs" "$(cat "$NODE_LOG")"

plan902="$TMP/plans/repair-pr-902.yaml"
[ -f "$plan902" ] || fail "tick 1: plan file missing for #902"
grep -q "^repoUrl: https://github.com/fake/repo.git$" "$plan902" \
  || fail "plan902: repoUrl must be set (parseRawPlan requires it)" "$(cat "$plan902")"
grep -q "^onFinish: none$" "$plan902" || fail "plan902: must not open its own PR" "$(cat "$plan902")"
grep -q "Blocker category: failed_checks" "$plan902" || fail "plan902: wrong category" "$(cat "$plan902")"

plan903="$TMP/plans/repair-pr-903.yaml"
[ -f "$plan903" ] || fail "tick 1: plan file missing for #903"
grep -q "Blocker category: changes_requested" "$plan903" || fail "plan903: wrong category" "$(cat "$plan903")"

# Tick 2: same head-state -> fingerprint dedup, no re-submission.
node_calls_before="$(wc -l < "$NODE_LOG")"
out="$(run_cron)" || fail "tick 2 exited non-zero" "$out"
echo "$out" | grep -q "PR #901: repair already submitted for this head-state" \
  || fail "tick 2: expected dedup for #901" "$out"
echo "$out" | grep -q "PR #902: repair already submitted for this head-state" \
  || fail "tick 2: expected dedup for #902" "$out"
node_calls_after="$(wc -l < "$NODE_LOG")"
[ "$node_calls_before" -eq "$node_calls_after" ] || fail "tick 2: dedup breached, node was invoked again"

# Tick 3: attempt cap -> one-time exhausted comment for #902.
fp="$(awk -F '\t' '$1 == "queue-submitted" && $2 == "902" { print $3 }' "$TMP/ledger.tsv")"
[ -n "$fp" ] || fail "could not read fingerprint from ledger for #902"
grep -v "^queue-submitted	902	" "$TMP/ledger.tsv" > "$TMP/ledger2.tsv" && mv "$TMP/ledger2.tsv" "$TMP/ledger.tsv"
for _ in 1 2; do printf 'queue-attempt\t902\t%s\t%s\n' "$fp" "$(date +%s)" >> "$TMP/ledger.tsv"; done
out="$(run_cron)" || fail "tick 3 exited non-zero" "$out"
echo "$out" | grep -q "PR #902: attempt cap reached" \
  || fail "tick 3: expected attempt cap to fire for #902" "$out"
comments="$(grep -c "^gh pr comment 902" "$FAKE_GH_STATE_DIR/calls.log" || true)"
[ "$comments" -eq 1 ] || fail "expected exactly one exhausted PR comment for #902, got $comments"
out="$(run_cron)" || fail "tick 4 exited non-zero" "$out"
comments="$(grep -c "^gh pr comment 902" "$FAKE_GH_STATE_DIR/calls.log" || true)"
[ "$comments" -eq 1 ] || fail "exhausted comment must be one-time; got $comments"

# Submission failure: transient IPC failures do not consume attempt budget.
: > "$TMP/ledger.tsv"
: > "$NODE_LOG"
out="$(run_cron env FAKE_NODE_FAIL=1)" || fail "submit-failure tick exited non-zero" "$out"
echo "$out" | grep -q "PR #902: plan submit failed: simulated ipc failure" \
  || fail "submit-failure tick: expected ad-hoc plan failure to be logged" "$out"
attempts="$(awk -F '\t' '$1 == "queue-attempt" { c++ } END { print c + 0 }' "$TMP/ledger.tsv")"
[ "$attempts" -eq 0 ] \
  || fail "submit failures must not consume queue attempts" "$(cat "$TMP/ledger.tsv")"

# DRY_RUN: route logged, nothing submitted.
: > "$TMP/ledger.tsv"
node_calls_before="$(wc -l < "$NODE_LOG")"
out="$(run_cron env INVOKER_PR_CRON_DRY_RUN=1)" || fail "dry-run exited non-zero" "$out"
echo "$out" | grep -q "PR #901: DRY-RUN would route category=conflict wf=wf-mapped-901" \
  || fail "dry-run: expected the would-route log for #901" "$out"
node_calls_after="$(wc -l < "$NODE_LOG")"
[ "$node_calls_before" -eq "$node_calls_after" ] || fail "dry-run submitted a task"

echo "[repro] passed"
