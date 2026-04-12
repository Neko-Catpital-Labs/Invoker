#!/usr/bin/env bash
# Group 2.9 — diamond: A→B,C→D. B fails, C completes, D stays pending.
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

STA=$(invoker_e2e_task_status e2e-g229-taskA)
STB=$(invoker_e2e_task_status e2e-g229-taskB)
STC=$(invoker_e2e_task_status e2e-g229-taskC)
STD=$(invoker_e2e_task_status e2e-g229-taskD)
if [ "$STA" != "completed" ] || [ "$STB" != "failed" ] || [ "$STC" != "completed" ] || [ "$STD" != "pending" ]; then
  echo "FAIL case 2.9: expected A=completed B=failed C=completed D=pending, got A='$STA' B='$STB' C='$STC' D='$STD'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 2.9 (diamond fail: A=completed, B=failed, C=completed, D=pending)"
