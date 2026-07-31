#!/usr/bin/env bash
# Repro: a delegated bot review-thread repair must be picked up by the
# admin-bypass queue worker instead of being skipped as "no actionable blocker".
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-admin-bypass-queue-bot-review-thread.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

mkdir -p "$TMP/bin" "$TMP/state" "$TMP/home" "$TMP/plans"
export FAKE_GH_STATE_DIR="$TMP/state"

cat > "$FAKE_GH_STATE_DIR/state.json" <<'JSON'
{
  "prs": [
    {
      "number": 908,
      "title": "Bot review thread delegated repair",
      "body": "## Summary\n\nBot review-thread queue repro.\n",
      "url": "https://github.com/fake/repo/pull/908",
      "state": "OPEN",
      "isDraft": false,
      "baseRefName": "master",
      "headRefName": "stack/908",
      "headRefOid": "8888888888888888888888888888888888888888",
      "mergeStateStatus": "BLOCKED",
      "mergeable": "MERGEABLE",
      "labels": ["admin-bypass"],
      "reviewDecision": "REVIEW_REQUIRED",
      "reviewThreads": [
        {
          "id": "PRRT_bot908",
          "isResolved": false,
          "isOutdated": false,
          "comments": {
            "nodes": [
              {
                "author": {"login": "coderabbitai[bot]"},
                "body": "Update the retry-task registration assertion so it checks the concrete dispatcher set call."
              }
            ]
          }
        }
      ],
      "checks": {"*": "SUCCESS"}
    }
  ],
  "issue_comments": {"908": []},
  "job_logs": {}
}
JSON

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"
: > "$NODE_LOG"
cat > "$TMP/bin/node" <<EOF
#!/usr/bin/env bash
printf 'node args=%s\n' "\$*" >> "$NODE_LOG"
exit 0
EOF
chmod +x "$TMP/bin/node"

cat > "$TMP/review-gate.sh" <<'RG'
#!/usr/bin/env bash
printf '{}\n'
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
  bash "$ROOT/scripts/cron-admin-bypass-queue.sh" 2>&1
}

out="$(run_cron)" || fail "tick exited non-zero" "$out"
echo "$out" | grep -q "PR #908: submitted ad-hoc repair plan (category=bot_review_thread" \
  || fail "expected bot review thread to submit an ad-hoc repair plan" "$out"
! echo "$out" | grep -q "PR #908: no actionable blocker found; skipping" \
  || fail "bot review thread was skipped as non-actionable" "$out"
node_calls="$(wc -l < "$NODE_LOG")"
[ "$node_calls" -eq 1 ] || fail "expected exactly one node call, got $node_calls" "$(cat "$NODE_LOG")"

plan="$TMP/plans/repair-pr-908.yaml"
[ -f "$plan" ] || fail "plan file missing for #908"
grep -q "Blocker category: bot_review_thread" "$plan" \
  || fail "plan: wrong category" "$(cat "$plan")"
grep -q "unresolved bot review thread PRRT_bot908" "$plan" \
  || fail "plan: missing thread detail" "$(cat "$plan")"
grep -q "Update the retry-task registration assertion" "$plan" \
  || fail "plan: missing bot thread body" "$(cat "$plan")"

echo "[repro] passed"
