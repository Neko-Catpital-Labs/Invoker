#!/usr/bin/env bash
# Group 2.8 — sequential: A fails, fix, reject → B stays pending.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.8: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 2.8: submit plan (A will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.8-fix-reject-downstream.yaml" || true

STA=$(invoker_e2e_task_status e2e-g228-taskA)
STB=$(invoker_e2e_task_status e2e-g228-taskB)
if [ "$STA" != "failed" ] || [ "$STB" != "pending" ]; then
  echo "FAIL case 2.8: expected A=failed B=pending, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 2.8: confirmed A=failed, B=pending"

echo "==> case 2.8: fix A (claude-marker.sh runs)"
invoker_e2e_run_headless fix e2e-g228-taskA

STA=$(invoker_e2e_task_status e2e-g228-taskA)
if [ "$STA" != "awaiting_approval" ]; then
  echo "FAIL case 2.8: expected A=awaiting_approval after fix, got '$STA'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 2.8: confirmed A=awaiting_approval"

echo "==> case 2.8: reject A"
invoker_e2e_run_headless reject e2e-g228-taskA

STA=$(invoker_e2e_task_status e2e-g228-taskA)
STB=$(invoker_e2e_task_status e2e-g228-taskB)
if [ "$STA" != "failed" ] || [ "$STB" != "pending" ]; then
  echo "FAIL case 2.8: expected A=failed B=pending after reject, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 2.8 (fix A → reject → A=failed, B=pending throughout)"
