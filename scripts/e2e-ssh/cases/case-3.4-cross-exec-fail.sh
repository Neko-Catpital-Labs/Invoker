#!/usr/bin/env bash
# Group 3.4 — cross-executor failure: SSH B fails, worktree C stays pending.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/ssh-common.sh"

invoker_e2e_ssh_init
trap invoker_e2e_ssh_full_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 3.4: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 3.4: submit plan (SSH B will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-ssh/3.4-cross-exec-fail.yaml" || true

STA=$(invoker_e2e_task_status e2e-g334-taskA)
STB=$(invoker_e2e_task_status e2e-g334-taskB)
STC=$(invoker_e2e_task_status e2e-g334-taskC)
if [ "$STA" != "completed" ] || [ "$STB" != "failed" ] || [ "$STC" != "pending" ]; then
  echo "FAIL case 3.4: expected A=completed B=failed C=pending, got A='$STA' B='$STB' C='$STC'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 3.4 (cross-executor fail: A=completed, B[ssh]=failed, C=pending)"
