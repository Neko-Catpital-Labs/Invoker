#!/usr/bin/env bash
# Group 1.6 — fix-with-claude then reject.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 1.6: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 1.6: submit plan (task will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group1-single-task/1.6-fix-reject.yaml" || true
invoker_e2e_wait_settled e2e-g116-task

ST=$(invoker_e2e_task_status e2e-g116-task)
if [ "$ST" != "failed" ]; then
  echo "FAIL case 1.6: expected status=failed after submit, got '$ST'"
  exit 1
fi
echo "==> case 1.6: confirmed status=failed"

echo "==> case 1.6: fix (claude-marker.sh runs)"
invoker_e2e_run_headless fix e2e-g116-task
invoker_e2e_wait_settled e2e-g116-task

ST=$(invoker_e2e_task_status e2e-g116-task)
if [ "$ST" != "awaiting_approval" ]; then
  echo "FAIL case 1.6: expected status=awaiting_approval after fix, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 1.6: confirmed status=awaiting_approval"

echo "==> case 1.6: reject"
invoker_e2e_run_headless reject e2e-g116-task
invoker_e2e_wait_settled e2e-g116-task

ST=$(invoker_e2e_task_status e2e-g116-task)
if [ "$ST" != "failed" ]; then
  echo "FAIL case 1.6: expected status=failed after reject, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 1.6 (e2e-g116-task fix → reject → failed)"
