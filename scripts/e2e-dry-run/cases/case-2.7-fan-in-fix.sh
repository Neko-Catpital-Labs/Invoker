#!/usr/bin/env bash
# Group 2.7 — fan-in: A fails, fix+approve A → C unblocks and completes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.7: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 2.7: submit plan (A will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.7-fan-in-fix.yaml" || true

STA=$(invoker_e2e_task_status e2e-g227-taskA)
STB=$(invoker_e2e_task_status e2e-g227-taskB)
STC=$(invoker_e2e_task_status e2e-g227-taskC)
if [ "$STA" != "failed" ] || [ "$STB" != "completed" ] || [ "$STC" != "pending" ]; then
  echo "FAIL case 2.7: expected A=failed B=completed C=pending, got A='$STA' B='$STB' C='$STC'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 2.7: confirmed A=failed, B=completed, C=pending"

echo "==> case 2.7: fix A (claude-marker.sh runs)"
invoker_e2e_run_headless fix e2e-g227-taskA

STA=$(invoker_e2e_task_status e2e-g227-taskA)
if [ "$STA" != "awaiting_approval" ]; then
  echo "FAIL case 2.7: expected A=awaiting_approval after fix, got '$STA'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 2.7: confirmed A=awaiting_approval"

echo "==> case 2.7: approve A"
invoker_e2e_run_headless approve e2e-g227-taskA

STA=$(invoker_e2e_task_status e2e-g227-taskA)
STB=$(invoker_e2e_task_status e2e-g227-taskB)
STC=$(invoker_e2e_task_status e2e-g227-taskC)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ] || [ "$STC" != "completed" ]; then
  echo "FAIL case 2.7: expected all completed, got A='$STA' B='$STB' C='$STC'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 2.7 (fan-in fix: A=failed → fix → approve → A,B,C all completed)"
