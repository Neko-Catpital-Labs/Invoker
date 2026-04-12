#!/usr/bin/env bash
# Group 2.11 — A fails, edit command to fix, B runs after restart succeeds.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.11: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 2.11: submit plan (A will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.11-edit-restart-downstream.yaml" || true

STA=$(invoker_e2e_task_status e2e-g2211-taskA)
STB=$(invoker_e2e_task_status e2e-g2211-taskB)
if [ "$STA" != "failed" ] || [ "$STB" != "pending" ]; then
  echo "FAIL case 2.11: expected A=failed B=pending, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 2.11: confirmed A=failed, B=pending"

echo "==> case 2.11: edit A command + restart"
invoker_e2e_run_headless edit e2e-g2211-taskA echo ok

STA=$(invoker_e2e_task_status e2e-g2211-taskA)
STB=$(invoker_e2e_task_status e2e-g2211-taskB)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ]; then
  echo "FAIL case 2.11: expected A=completed B=completed, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 2.11 (edit A → restart → A=completed, B=completed)"
