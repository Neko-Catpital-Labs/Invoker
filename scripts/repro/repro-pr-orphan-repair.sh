#!/usr/bin/env bash
# Battle-test: the orphan-repair cron owns UNMAPPED broken PRs end-to-end
# against a fake GitHub (pr-orphan-broken.json):
#   #801 unmapped, conflict + failing check + changes-requested
#       -> ONE combined Invoker repair task submitted via `run`, whose plan
#          carries all three blockers in order and onFinish: none
#   #802 unmapped, healthy      -> untouched
#   #803 mapped, broken         -> skipped (existing workers own it)
# Then: same tick again -> fingerprint dedup, no second submission.
# Then: attempt cap -> one-time exhausted PR comment, no more submissions.
# Then: DRY_RUN=1 -> logs the plan, submits nothing.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-orphan-repair.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home" "$TMP/plans"
export FAKE_GH_STATE_DIR="$TMP/state"
cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/pr-orphan-broken.json" "$FAKE_GH_STATE_DIR/state.json"

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"; : > "$NODE_LOG"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node %s\n' "\$*" >> "$NODE_LOG"
exit 0
EOF
chmod +x "$TMP/bin/node"

# Review-gate stub: #803 is mapped, everything else is a clean miss.
cat > "$TMP/review-gate.sh" <<'RG'
#!/usr/bin/env bash
if [ "${1:-}" = "803" ]; then
  printf '{"workflowId":"wf-mapped-803","workflowGeneration":2,"baseBranch":"master"}\n'
else
  printf '{}\n'
fi
RG
chmod +x "$TMP/review-gate.sh"

run_cron() {
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_PR_CRON_AUTHOR="fake-bot" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_PR_ORPHAN_STATE_FILE="$TMP/ledger.tsv" \
  INVOKER_PR_ORPHAN_PLAN_DIR="$TMP/plans" \
  INVOKER_PR_ORPHAN_MAX_ATTEMPTS=3 \
  "$@" \
  bash "$ROOT/scripts/cron-pr-orphan-repair.sh" 2>&1
}

# ── Tick 1: exactly one combined repair task for #801 ──
out="$(run_cron)" || fail "tick 1 exited non-zero" "$out"
echo "$out" | grep -q "PR #803: mapped to workflow wf-mapped-803" \
  || fail "tick 1: mapped PR #803 must be skipped via review-gate" "$out"
echo "$out" | grep -q "PR #801: submitted repair task" \
  || fail "tick 1: expected a submitted repair task for #801" "$out"
echo "$out" | grep -q "PR #802" \
  && fail "tick 1: healthy PR #802 must be untouched" "$out"

runs="$(grep -c "exec -- run " "$NODE_LOG" || true)"
[ "$runs" -eq 1 ] || fail "tick 1: expected exactly 1 run submission, got $runs"

plan="$TMP/plans/repair-pr-801.yaml"
[ -f "$plan" ] || fail "tick 1: plan file missing at $plan"
grep -q "^name: repair-pr-801-" "$plan" || fail "plan: bad name" "$(cat "$plan")"
grep -q "^onFinish: none$" "$plan" || fail "plan: must not open its own PR (onFinish none)" "$(cat "$plan")"
grep -q "1. conflict:" "$plan" || fail "plan: conflict must be blocker #1" "$(cat "$plan")"
grep -q "2. failed_checks: Unit Tests" "$plan" || fail "plan: failing check must be blocker #2" "$(cat "$plan")"
grep -q "3. changes_requested:" "$plan" || fail "plan: review feedback must be blocker #3" "$(cat "$plan")"
grep -q "git fetch origin feature/orphan-801" "$plan" || fail "plan: must target the existing PR branch" "$(cat "$plan")"
grep -q "repair-pr-802" "$NODE_LOG" && fail "healthy PR #802 got a repair plan"
grep -q "repair-pr-803" "$NODE_LOG" && fail "mapped PR #803 got a repair plan"

# ── Tick 2: same head-state -> fingerprint dedup, no second submission ──
out="$(run_cron)" || fail "tick 2 exited non-zero" "$out"
echo "$out" | grep -q "PR #801: repair already submitted for this head-state" \
  || fail "tick 2: expected fingerprint dedup for #801" "$out"
runs="$(grep -c "exec -- run " "$NODE_LOG" || true)"
[ "$runs" -eq 1 ] || fail "tick 2: dedup breached; got $runs submissions"

# ── Tick 3: attempt cap -> one-time exhausted comment ──
fp="$(awk -F '\t' '$1 == "orphan-submitted" && $2 == "801" { print $3 }' "$TMP/ledger.tsv")"
[ -n "$fp" ] || fail "could not read fingerprint from ledger"
grep -v "^orphan-submitted	801	" "$TMP/ledger.tsv" > "$TMP/ledger2.tsv" && mv "$TMP/ledger2.tsv" "$TMP/ledger.tsv"
for _ in 1 2; do printf 'orphan-attempt\t801\t%s\t%s\n' "$fp" "$(date +%s)" >> "$TMP/ledger.tsv"; done
out="$(run_cron)" || fail "tick 3 exited non-zero" "$out"
echo "$out" | grep -q "PR #801: attempt cap reached" \
  || fail "tick 3: expected the attempt cap to fire" "$out"
comments="$(grep -c "^gh pr comment 801" "$FAKE_GH_STATE_DIR/calls.log" || true)"
[ "$comments" -eq 1 ] || fail "expected exactly one exhausted PR comment, got $comments"
out="$(run_cron)" || fail "tick 4 exited non-zero" "$out"
comments="$(grep -c "^gh pr comment 801" "$FAKE_GH_STATE_DIR/calls.log" || true)"
[ "$comments" -eq 1 ] || fail "exhausted comment must be one-time; got $comments"

# ── DRY_RUN: plan logged, nothing submitted ──
: > "$TMP/ledger.tsv"
runs_before="$(grep -c "exec -- run " "$NODE_LOG" || true)"
out="$(run_cron env INVOKER_PR_CRON_DRY_RUN=1)" || fail "dry-run exited non-zero" "$out"
echo "$out" | grep -q "PR #801: DRY-RUN would submit repair task" \
  || fail "dry-run: expected the would-submit log" "$out"
runs_after="$(grep -c "exec -- run " "$NODE_LOG" || true)"
[ "$runs_before" -eq "$runs_after" ] || fail "dry-run submitted a task"

echo "[repro] passed"
