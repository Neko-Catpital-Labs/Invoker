#!/usr/bin/env bash
# Group 2.9 - diamond: A->B,C->D. B fails, workflow fails, D stays pending.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.9: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 2.9: submit plan (B will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.9-diamond-fail.yaml" || true

invoker_e2e_wait_task_status e2e-g229-taskB failed 180

WF_STATUS=""
for _ in {1..30}; do
  WF_STATUS=$(
    invoker_e2e_run_headless query workflows --output jsonl 2>/dev/null | python3 -c '
import json, sys
rows = []
for line in sys.stdin:
    line = line.strip()
    if line.startswith("{"):
        rows.append(json.loads(line))
print(rows[-1].get("status", "") if rows else "")
'
  )
  if [ "$WF_STATUS" = "failed" ]; then
    break
  fi
  sleep 1
done

STA=$(invoker_e2e_task_status e2e-g229-taskA)
STB=$(invoker_e2e_task_status e2e-g229-taskB)
STC=$(invoker_e2e_task_status e2e-g229-taskC)
STD=$(invoker_e2e_task_status e2e-g229-taskD)
if [ "$STA" != "completed" ] || [ "$STB" != "failed" ] || { [ "$STC" != "pending" ] && [ "$STC" != "completed" ]; } || [ "$STD" != "pending" ] || [ "$WF_STATUS" != "failed" ]; then
  echo "FAIL case 2.9: expected workflow=failed A=completed B=failed C=pending|completed D=pending, got workflow='$WF_STATUS' A='$STA' B='$STB' C='$STC' D='$STD'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 2.9 (diamond fail: workflow=failed, A=completed, B=failed, C=$STC, D=pending)"
