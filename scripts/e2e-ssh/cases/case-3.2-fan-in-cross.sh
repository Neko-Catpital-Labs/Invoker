#!/usr/bin/env bash
# Group 3.2 — cross-executor fan-in: worktree A + SSH B → worktree C.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/ssh-common.sh"

invoker_e2e_ssh_init
trap invoker_e2e_ssh_full_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 3.2: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 3.2: submit plan (--no-track)"
invoker_e2e_ssh_submit_plan_no_track "$INVOKER_E2E_REPO_ROOT/plans/e2e-ssh/3.2-fan-in-cross.yaml"

echo "==> case 3.2: wait for cross-executor fan-in tasks to complete"
invoker_e2e_ssh_wait_tasks_completed 300 \
  e2e-g332-taskA \
  e2e-g332-taskB \
  e2e-g332-taskC

STA=$(invoker_e2e_task_status e2e-g332-taskA)
STB=$(invoker_e2e_task_status e2e-g332-taskB)
STC=$(invoker_e2e_task_status e2e-g332-taskC)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ] || [ "$STC" != "completed" ]; then
  echo "FAIL case 3.2: expected all completed, got A='$STA' B='$STB' C='$STC'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 3.2 (fan-in cross-executor: A,B→C all completed)"
