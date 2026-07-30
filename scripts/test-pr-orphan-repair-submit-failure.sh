#!/usr/bin/env bash
# Regression test: orphan-repair submit failures must not consume retry budget.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-orphan-submit-failure.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[test] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home" "$TMP/plans"
export FAKE_GH_STATE_DIR="$TMP/state"
cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/pr-orphan-broken.json" "$FAKE_GH_STATE_DIR/state.json"

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"; : > "$NODE_LOG"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node env require=%s args=%s\n' "\${INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER:-}" "\$*" >> "$NODE_LOG"
echo "simulated ipc failure" >&2
exit 42
EOF
chmod +x "$TMP/bin/node"

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
  bash "$ROOT/scripts/cron-pr-orphan-repair.sh" 2>&1
}

out="$(run_cron)" || fail "submit-failure tick exited non-zero" "$out"
echo "$out" | grep -q "PR #801: submit failed: simulated ipc failure" \
  || fail "expected owner IPC failure to be logged" "$out"
grep -q "require=1" "$NODE_LOG" \
  || fail "worker IPC dispatch must require an existing owner" "$(cat "$NODE_LOG")"
grep -q "exec -- run .*repair-pr-801" "$NODE_LOG" \
  || fail "expected orphan repair to submit one run command" "$(cat "$NODE_LOG")"

attempts="$(awk -F '\t' '$1 == "orphan-attempt" { c++ } END { print c + 0 }' "$TMP/ledger.tsv")"
[ "$attempts" -eq 0 ] \
  || fail "submit failures must not consume orphan attempts" "$(cat "$TMP/ledger.tsv")"
submitted="$(awk -F '\t' '$1 == "orphan-submitted" { c++ } END { print c + 0 }' "$TMP/ledger.tsv")"
[ "$submitted" -eq 0 ] \
  || fail "submit failures must not be marked submitted" "$(cat "$TMP/ledger.tsv")"

echo "[test] passed"
