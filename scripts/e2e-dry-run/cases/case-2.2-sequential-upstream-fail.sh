#!/usr/bin/env bash
# Group 2.2 — sequential A→B, A fails so B stays pending.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.2: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 2.2: submit plan (A fails)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.2-sequential-upstream-fail.yaml" || true

STA=$(invoker_e2e_task_status e2e-g222-taskA)
STB=$(invoker_e2e_task_status e2e-g222-taskB)
if [ "$STA" != "failed" ] || [ "$STB" != "pending" ]; then
  echo "FAIL case 2.2: expected taskA=failed taskB=pending, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 2.2 (sequential upstream fail: A=failed, B=pending)"
