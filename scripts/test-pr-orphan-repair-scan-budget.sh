#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-orphan-scan-budget.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[test] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

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

RG_LOG="$TMP/review-gate.log"; : > "$RG_LOG"
cat > "$TMP/review-gate.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$1" >> "$RG_LOG"
sleep "\${FAKE_REVIEW_GATE_SLEEP:-0}"
printf '{}\n'
EOF
chmod +x "$TMP/review-gate.sh"

run_cron() {
  env \
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_PR_CRON_AUTHOR="fake-bot" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_PR_ORPHAN_STATE_FILE="$TMP/ledger.tsv" \
  INVOKER_PR_ORPHAN_PLAN_DIR="$TMP/plans" \
  "$@" \
  bash "$ROOT/scripts/cron-pr-orphan-repair.sh" </dev/null 2>&1
}

out="$(run_cron)" || fail "tick 1 exited non-zero" "$out"
grep -qx "802" "$RG_LOG" && fail "a PR with no blockers must not cost an owner lookup" "$(cat "$RG_LOG")"

: > "$RG_LOG"
out="$(run_cron)" || fail "tick 2 exited non-zero" "$out"
grep -qx "801" "$RG_LOG" && fail "a PR already submitted for this head-state must not cost an owner lookup" "$(cat "$RG_LOG")"
echo "$out" | grep -q "PR #801: repair already submitted for this head-state" \
  || fail "tick 2: expected dedup for #801" "$out"

: > "$TMP/ledger.tsv"; : > "$RG_LOG"; : > "$NODE_LOG"
out="$(run_cron FAKE_REVIEW_GATE_SLEEP=2 INVOKER_PR_ORPHAN_SCAN_BUDGET_SECS=1)" || fail "budget tick exited non-zero" "$out"
echo "$out" | grep -q "PR #803: scan budget of 1s reached; leaving it for a later tick" \
  || fail "expected the scan to stop once its time budget is spent" "$out"
lookups="$(wc -l < "$RG_LOG" | tr -d ' ')"
[ "$lookups" -eq 1 ] || fail "budget tick must stop after the first slow lookup; got $lookups" "$(cat "$RG_LOG")"
echo "$out" | grep -q "orphan-repair scan complete; submitted 1 repair task(s)" \
  || fail "budget tick must still finish and report" "$out"

echo "[test] passed"
