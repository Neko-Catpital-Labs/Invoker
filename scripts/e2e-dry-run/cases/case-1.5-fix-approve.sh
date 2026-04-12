#!/usr/bin/env bash
# Group 1.5 — fix-with-claude then approve.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 1.5: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 1.5: submit plan (task will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group1-single-task/1.5-fix-approve.yaml" || true
invoker_e2e_wait_settled e2e-g115-task

ST=$(invoker_e2e_task_status e2e-g115-task)
if [ "$ST" != "failed" ]; then
  echo "FAIL case 1.5: expected status=failed after submit, got '$ST'"
  exit 1
fi
echo "==> case 1.5: confirmed status=failed"

echo "==> case 1.5: fix (claude-marker.sh runs)"
invoker_e2e_run_headless fix e2e-g115-task
invoker_e2e_wait_settled e2e-g115-task

ST=$(invoker_e2e_task_status e2e-g115-task)
if [ "$ST" != "awaiting_approval" ]; then
  echo "FAIL case 1.5: expected status=awaiting_approval after fix, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 1.5: confirmed status=awaiting_approval"

echo "==> case 1.5: approve"
invoker_e2e_run_headless approve e2e-g115-task
invoker_e2e_wait_settled e2e-g115-task

ST=$(invoker_e2e_task_status e2e-g115-task)
if [ "$ST" != "completed" ]; then
  echo "FAIL case 1.5: expected status=completed after approve, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 1.5 (e2e-g115-task fix → approve → completed)"
