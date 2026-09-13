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
out="$(run_cron INVOKER_PR_ORPHAN_SCAN_BUDGET_SECS=0)" || fail "budget tick exited non-zero" "$out"
for pr in 801 803; do
  echo "$out" | grep -q "PR #$pr: scan budget of 0s reached; leaving it for a later tick" \
    || fail "expected PR #$pr to be left for a later tick once the budget is spent" "$out"
done
lookups="$(wc -l < "$RG_LOG" | tr -d ' ')"
[ "$lookups" -eq 0 ] || fail "a spent budget must stop every owner lookup; got $lookups" "$(cat "$RG_LOG")"
runs="$(grep -c "exec -- run " "$NODE_LOG" || true)"
[ "$runs" -eq 0 ] || fail "a PR left for a later tick must not be submitted; got $runs" "$(cat "$NODE_LOG")"
echo "$out" | grep -q "orphan-repair scan complete; submitted 0 repair task(s)" \
  || fail "budget tick must still finish and report" "$out"

echo "[test] passed"
