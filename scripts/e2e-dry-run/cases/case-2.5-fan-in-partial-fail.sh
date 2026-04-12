#!/usr/bin/env bash
# Group 2.5 — fan-in: A succeeds, B fails → C stays pending.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.5: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 2.5: submit plan (B fails)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.5-fan-in-partial-fail.yaml" || true

STA=$(invoker_e2e_task_status e2e-g225-taskA)
STB=$(invoker_e2e_task_status e2e-g225-taskB)
STC=$(invoker_e2e_task_status e2e-g225-taskC)
if [ "$STA" != "completed" ] || [ "$STB" != "failed" ] || [ "$STC" != "pending" ]; then
  echo "FAIL case 2.5: expected A=completed B=failed C=pending, got A='$STA' B='$STB' C='$STC'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 2.5 (fan-in partial fail: A=completed, B=failed, C=pending)"
