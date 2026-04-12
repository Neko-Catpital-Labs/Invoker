#!/usr/bin/env bash
# Group 2.12 — A has requiresManualApproval. Approve → B runs.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.12: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 2.12: submit plan (A has manual approval)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.12-manual-approve-downstream.yaml"

STA=$(invoker_e2e_task_status e2e-g2212-taskA)
STB=$(invoker_e2e_task_status e2e-g2212-taskB)
if [ "$STA" != "awaiting_approval" ] || [ "$STB" != "pending" ]; then
  echo "FAIL case 2.12: expected A=awaiting_approval B=pending, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 2.12: confirmed A=awaiting_approval, B=pending"

echo "==> case 2.12: approve A"
invoker_e2e_run_headless approve e2e-g2212-taskA

STA=$(invoker_e2e_task_status e2e-g2212-taskA)
STB=$(invoker_e2e_task_status e2e-g2212-taskB)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ]; then
  echo "FAIL case 2.12: expected A=completed B=completed, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 2.12 (manual approve A → A=completed, B=completed)"
