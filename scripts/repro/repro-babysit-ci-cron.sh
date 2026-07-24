#!/usr/bin/env bash
# Battle-test: the CI-failure cron scans open PRs against a fake GitHub and
# dispatches repair-review-gate-ci for the CI-failed PR while SKIPPING the
# conflicted (DIRTY) PR — the conflict-rebase worker owns conflicts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-babysit-ci.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home"
export FAKE_GH_STATE_DIR="$TMP/state"
cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/pr-ci-failed.json" "$FAKE_GH_STATE_DIR/state.json"

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"; : > "$NODE_LOG"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node %s\n' "\$*" >> "$NODE_LOG"
exit 0
EOF
chmod +x "$TMP/bin/node"

out="$(
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  bash "$ROOT/packages/execution-engine/scripts/cron-pr-ci-failure.sh" 2>&1
)" || fail "CI scan exited non-zero" "$out"

grep -q "exec -- repair-review-gate-ci 601" "$NODE_LOG" \
  || fail "expected repair-review-gate-ci dispatch for CI-failed PR #601" "$out"
grep -q "repair-review-gate-ci 602" "$NODE_LOG" \
  && fail "conflicted PR #602 must be skipped (rebase worker owns it)" "$out"
echo "$out" | grep -q "PR #602: skip conflicted PR" \
  || fail "expected explicit skip log for conflicted PR #602" "$out"

echo "[repro] passed"
