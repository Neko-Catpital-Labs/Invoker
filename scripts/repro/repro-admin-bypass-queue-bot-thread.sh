#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-admin-bypass-queue-bot-thread.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- detail -----" >&2
    echo "$2" >&2
  fi
  exit 1
}

mkdir -p "$TMP/bin" "$TMP/home" "$TMP/plans" "$TMP/state"
export FAKE_GH_STATE_DIR="$TMP/state"

ln -s "$ROOT/scripts/repro/fixtures/fake-gh/bin/gh" "$TMP/bin/gh"
NODE_LOG="$TMP/node-calls.log"
: > "$NODE_LOG"
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

python3 - "$TMP/state/state.json" <<'PY'
import json
import sys
from pathlib import Path

head = "9fc81429638a8a0b62bf7b9b337cd60f38461c53"
state = {
    "prs": [
        {
            "number": 6575,
            "title": "Provision a real isolated worktree for planning-chat sessions",
            "body": "## Summary\n\nWorktree provisioning slice.\n",
            "url": "https://github.com/fake/repo/pull/6575",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "stack/planning-chat-worktree",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewDecision": "REVIEW_REQUIRED",
            "reviewThreads": [
                {
                    "id": "PRRT_bot_6575",
                    "isResolved": False,
                    "isOutdated": False,
                    "comments": {
                        "nodes": [
                            {"author": {"login": "coderabbitai[bot]"}},
                            {"author": {"login": "EdbertChan"}},
                        ]
                    },
                }
            ],
            "checks": {"*": "SUCCESS"},
        }
    ],
    "issue_comments": {"6575": []},
    "job_logs": {},
}
Path(sys.argv[1]).write_text(json.dumps(state, indent=2), encoding="utf-8")
PY

run_cron() {
  PATH="$TMP/bin:$PATH" \
  HOME="$TMP/home" \
  INVOKER_GITHUB_TARGET_REPO="fake/repo" \
  INVOKER_PR_CRON_AUTHOR="fake-bot" \
  INVOKER_PR_CRON_LOCK="$TMP/crons.lock" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$TMP/review-gate.sh" \
  INVOKER_ADMIN_BYPASS_QUEUE_STATE_FILE="$TMP/admin-bypass-queue.tsv" \
  INVOKER_ADMIN_BYPASS_QUEUE_PLAN_DIR="$TMP/plans" \
  bash "$ROOT/scripts/cron-admin-bypass-queue.sh" 2>&1
}

out="$(run_cron)" || fail "cron exited non-zero" "$out"
echo "$out" | grep -q "PR #6575: submitted ad-hoc repair plan (category=bot_review_thread" \
  || fail "expected bot review thread to submit an ad-hoc repair plan" "$out"

plan="$TMP/plans/repair-pr-6575.yaml"
[ -f "$plan" ] || fail "expected repair plan file for #6575" "$out"
grep -q "Blocker category: bot_review_thread" "$plan" \
  || fail "plan did not preserve bot_review_thread category" "$(cat "$plan")"
grep -q "unresolved bot review thread PRRT_bot_6575" "$plan" \
  || fail "plan did not name the unresolved bot thread" "$(cat "$plan")"
grep -q "bot review thread" "$plan" \
  || fail "plan did not instruct the repair task how to handle bot threads" "$(cat "$plan")"

grep -q "exec --no-track -- run .*repair-pr-6575.yaml" "$NODE_LOG" \
  || fail "expected Invoker run submission through headless IPC" "$(cat "$NODE_LOG")"

echo "[repro] passed"
