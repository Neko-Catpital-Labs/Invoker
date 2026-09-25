#!/usr/bin/env bash
# Regression test: an orphan-repair safe-push task is a no-op when the PR
# closed after the repair task was submitted.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-orphan-safe-push-closed.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[test] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home" "$TMP/plans"
export FAKE_GH_STATE_DIR="$TMP/state"
cp "$ROOT/scripts/repro/fixtures/fake-gh/scenarios/pr-orphan-broken.json" "$FAKE_GH_STATE_DIR/state.json"
CRON_OUT="$TMP/orphan-safe-push-closed.out"

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"; : > "$NODE_LOG"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node %s\n' "\$*" >> "$NODE_LOG"
exit 0
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

PATH="$TMP/bin:$PATH" \
HOME="$TMP/home" \
INVOKER_GITHUB_TARGET_REPO="fake/repo" \
INVOKER_GITHUB_TARGET_REPOS="fake/repo" \
INVOKER_PR_CRON_AUTHOR="fake-bot" \
INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
INVOKER_PR_ORPHAN_STATE_FILE="$TMP/ledger.tsv" \
INVOKER_PR_ORPHAN_PLAN_DIR="$TMP/plans" \
bash "$ROOT/scripts/cron-pr-orphan-repair.sh" >"$CRON_OUT" 2>&1 \
  || fail "cron exited non-zero" "$(cat "$CRON_OUT")"

plan="$TMP/plans/repair-pr-801.yaml"
[ -f "$plan" ] || fail "plan file missing" "$(cat "$CRON_OUT")"
awk '
  $0 == "    command: |" { in_cmd = 1; next }
  in_cmd && /^      / { sub(/^      /, ""); print; next }
  in_cmd { exit }
' "$plan" > "$TMP/safe-push.sh"
chmod +x "$TMP/safe-push.sh"

jq '(.prs[] | select(.number == 801) | .state) = "MERGED"' \
  "$FAKE_GH_STATE_DIR/state.json" > "$TMP/state/updated.json"
mv "$TMP/state/updated.json" "$FAKE_GH_STATE_DIR/state.json"

GIT_LOG="$TMP/git-calls.log"; : > "$GIT_LOG"
cat > "$TMP/bin/git" <<'EOF'
#!/usr/bin/env bash
printf 'git %s\n' "$*" >> "$GIT_LOG"
case "${1:-}" in
  ls-remote) exit 0 ;;
  rev-parse) printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n'; exit 0 ;;
  push) echo "push must not run for a closed PR" >&2; exit 99 ;;
  *) exit 64 ;;
esac
EOF
chmod +x "$TMP/bin/git"
export GIT_LOG

out="$(PATH="$TMP/bin:$PATH" bash "$TMP/safe-push.sh" 2>&1)" \
  || fail "closed PR safe-push must exit 0" "$out"
echo "$out" | grep -q "PR #801 is MERGED; nothing to push" \
  || fail "closed PR safe-push must explain the no-op" "$out"
grep -q '^git ' "$GIT_LOG" \
  && fail "closed PR safe-push must not inspect or push git refs" "$(cat "$GIT_LOG")"

echo "[test] passed"
