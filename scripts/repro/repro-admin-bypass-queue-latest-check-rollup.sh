#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-admin-bypass-queue-latest-check-rollup.XXXXXX")"
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

write_state() {
  local latest_conclusion="$1"
  local latest_completed_at="$2"
  python3 - "$TMP/state/state.json" "$latest_conclusion" "$latest_completed_at" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
latest_conclusion = sys.argv[2]
latest_completed_at = sys.argv[3]
head = "20ad4589cad5a80961a0e4124828306b7ec76ef4"
state = {
    "prs": [
        {
            "number": 6838,
            "title": "Add admin-bypass repair queue repros",
            "body": "## Summary\n\nQueue repair repros.\n",
            "url": "https://github.com/fake/repo/pull/6838",
            "state": "OPEN",
            "isDraft": False,
            "baseRefName": "master",
            "headRefName": "fix/admin-bypass-repair-queue-repros",
            "headRefOid": head,
            "mergeStateStatus": "BLOCKED",
            "mergeable": "MERGEABLE",
            "labels": ["admin-bypass"],
            "reviewDecision": "REVIEW_REQUIRED",
            "reviewThreads": [],
            "statusCheckRollup": [
                {
                    "__typename": "CheckRun",
                    "name": "PR Body",
                    "conclusion": "CANCELLED",
                    "status": "COMPLETED",
                    "startedAt": "2026-07-31T07:15:12Z",
                    "completedAt": "2026-07-31T07:15:28Z",
                    "detailsUrl": "https://github.com/fake/repo/actions/runs/1/job/1",
                },
                {
                    "__typename": "CheckRun",
                    "name": "PR Body",
                    "conclusion": latest_conclusion,
                    "status": "COMPLETED",
                    "startedAt": "2026-07-31T07:17:11Z",
                    "completedAt": latest_completed_at,
                    "detailsUrl": "https://github.com/fake/repo/actions/runs/2/job/2",
                },
                {
                    "__typename": "CheckRun",
                    "name": "Rule: autoqueue admin-bypass PRs to master (queue)",
                    "conclusion": "",
                    "status": "IN_PROGRESS",
                    "startedAt": "2026-07-31T07:26:05Z",
                    "completedAt": "",
                    "detailsUrl": "",
                },
            ],
        }
    ],
    "issue_comments": {"6838": []},
    "job_logs": {},
}
path.write_text(json.dumps(state, indent=2), encoding="utf-8")
PY
}

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

write_state "SUCCESS" "2026-07-31T07:26:44Z"
out="$(run_cron)" || fail "success-after-cancelled tick exited non-zero" "$out"
echo "$out" | grep -q "PR #6838: no actionable blocker found; skipping" \
  || fail "latest successful PR Body should suppress older cancelled run" "$out"
[ ! -e "$TMP/plans/repair-pr-6838.yaml" ] \
  || fail "latest successful PR Body still submitted a repair plan" "$(cat "$TMP/plans/repair-pr-6838.yaml")"
[ ! -s "$NODE_LOG" ] \
  || fail "latest successful PR Body still invoked Invoker" "$(cat "$NODE_LOG")"

write_state "CANCELLED" "2026-07-31T07:26:44Z"
out="$(run_cron)" || fail "latest-cancelled tick exited non-zero" "$out"
echo "$out" | grep -q "PR #6838: submitted ad-hoc repair plan (category=failed_checks" \
  || fail "latest cancelled PR Body should still submit a failed-check repair" "$out"
plan="$TMP/plans/repair-pr-6838.yaml"
[ -f "$plan" ] || fail "expected repair plan for latest cancelled PR Body" "$out"
grep -q "Blocker category: failed_checks" "$plan" \
  || fail "plan did not preserve failed_checks category" "$(cat "$plan")"
grep -q "Detail: PR Body" "$plan" \
  || fail "plan did not name PR Body as the blocker" "$(cat "$plan")"
grep -q "exec --no-track -- run .*repair-pr-6838.yaml" "$NODE_LOG" \
  || fail "expected Invoker run submission for latest cancelled PR Body" "$(cat "$NODE_LOG")"

echo "[repro] passed"
