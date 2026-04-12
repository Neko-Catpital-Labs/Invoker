#!/usr/bin/env bash
# Group 3.1 — worktree → SSH sequential: A writes marker, B reads via SSH.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/ssh-common.sh"

invoker_e2e_ssh_init
trap invoker_e2e_ssh_full_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 3.1: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 3.1: submit plan"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-ssh/3.1-worktree-to-ssh.yaml"

STA=$(invoker_e2e_task_status e2e-g331-taskA)
STB=$(invoker_e2e_task_status e2e-g331-taskB)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ]; then
  echo "FAIL case 3.1: expected A=completed B=completed, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 3.1 (worktree→SSH: A=completed, B=completed)"
