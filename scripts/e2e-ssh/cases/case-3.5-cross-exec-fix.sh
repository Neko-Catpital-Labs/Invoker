#!/usr/bin/env bash
# Group 3.5 — cross-executor fix: SSH B fails, fix+approve → C unblocks.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/ssh-common.sh"

invoker_e2e_ssh_init
trap invoker_e2e_ssh_full_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 3.5: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 3.5: submit plan (SSH B will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-ssh/3.5-cross-exec-fix.yaml" || true

STA=$(invoker_e2e_task_status e2e-g335-taskA)
STB=$(invoker_e2e_task_status e2e-g335-taskB)
STC=$(invoker_e2e_task_status e2e-g335-taskC)
if [ "$STA" != "completed" ] || [ "$STB" != "failed" ] || [ "$STC" != "pending" ]; then
  echo "FAIL case 3.5: expected A=completed B=failed C=pending, got A='$STA' B='$STB' C='$STC'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 3.5: confirmed A=completed, B=failed, C=pending"

echo "==> case 3.5: fix B (claude-marker.sh runs)"
invoker_e2e_run_headless fix e2e-g335-taskB

STB=$(invoker_e2e_task_status e2e-g335-taskB)
if [ "$STB" != "awaiting_approval" ]; then
  echo "FAIL case 3.5: expected B=awaiting_approval after fix, got '$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 3.5: confirmed B=awaiting_approval"

echo "==> case 3.5: approve B"
invoker_e2e_run_headless approve e2e-g335-taskB

STA=$(invoker_e2e_task_status e2e-g335-taskA)
STB=$(invoker_e2e_task_status e2e-g335-taskB)
STC=$(invoker_e2e_task_status e2e-g335-taskC)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ] || [ "$STC" != "completed" ]; then
  echo "FAIL case 3.5: expected all completed, got A='$STA' B='$STB' C='$STC'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 3.5 (cross-executor fix: B[ssh]=failed → fix → approve → all completed)"
