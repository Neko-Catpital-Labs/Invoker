#!/usr/bin/env bash
# Regression test: an open PR whose recorded head branch no longer exists in
# the target repo must not spawn a repair task whose downstream safe-push can
# only fail with "stale-head: ... missing".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/test-orphan-missing-head.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[test] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home" "$TMP/plans"
export FAKE_GH_STATE_DIR="$TMP/state"
cat > "$FAKE_GH_STATE_DIR/state.json" <<'JSON'
{
  "prs": [
    {
      "number": 13286,
      "title": "Broken PR whose branch was deleted",
      "url": "https://github.com/fake/repo/pull/13286",
      "state": "OPEN",
      "isDraft": false,
      "baseRefName": "master",
      "headRefName": "stack/deleted-branch",
      "headRefOid": "2ec6417a8423776cdca8fa98c454e6acf212fcb2",
      "headRefMissing": true,
      "mergeStateStatus": "BLOCKED",
      "mergeable": "MERGEABLE",
      "reviewDecision": "",
      "labels": [],
      "reviewThreads": [],
      "checks": {
        "Known Failure": "FAILURE"
      }
    }
  ],
  "issue_comments": {
    "13286": []
  }
}
JSON

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
printf '{}\n'
RG
chmod +x "$TMP/review-gate.sh"

out="$(
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_GITHUB_TARGET_REPOS="fake/repo" \
  INVOKER_PR_CRON_AUTHOR="fake-bot" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_PR_ORPHAN_STATE_FILE="$TMP/ledger.tsv" \
  INVOKER_PR_ORPHAN_PLAN_DIR="$TMP/plans" \
  bash "$ROOT/scripts/cron-pr-orphan-repair.sh" </dev/null 2>&1
)" || fail "tick exited non-zero" "$out"

grep -q "PR #13286: head branch stack/deleted-branch is unavailable on fake/repo; skipping" <<<"$out" \
  || fail "missing branch must be logged as an unsafe orphan-repair target" "$out"
grep -q "exec -- run " "$NODE_LOG" \
  && fail "missing branch must not submit a repair plan" "$(cat "$NODE_LOG")"
find "$TMP/plans" -type f -name '*.yaml' | grep -q . \
  && fail "missing branch must not write a plan" "$(find "$TMP/plans" -type f -name '*.yaml' -print)"

echo "[test] passed"
