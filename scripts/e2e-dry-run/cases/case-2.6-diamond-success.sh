#!/usr/bin/env bash
# Group 2.6 — diamond: A → B,C → D. All succeed.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.6: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 2.6: submit plan"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.6-diamond-success.yaml"

STA=$(invoker_e2e_task_status e2e-g226-taskA)
STB=$(invoker_e2e_task_status e2e-g226-taskB)
STC=$(invoker_e2e_task_status e2e-g226-taskC)
STD=$(invoker_e2e_task_status e2e-g226-taskD)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ] || [ "$STC" != "completed" ] || [ "$STD" != "completed" ]; then
  echo "FAIL case 2.6: expected all completed, got A='$STA' B='$STB' C='$STC' D='$STD'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 2.6 (diamond A→B,C→D all completed)"
