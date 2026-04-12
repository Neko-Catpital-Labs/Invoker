#!/usr/bin/env bash
# Group 4.1 — fix task A → approve → downstream B completes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 4.1: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 4.1: submit plan (task A will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group4-fix-merge/4.1-fix-downstream.yaml" || true

STA=$(invoker_e2e_task_status e2e-g441-taskA)
if [ "$STA" != "failed" ]; then
  echo "FAIL case 4.1: expected A=failed after submit, got '$STA'"
  exit 1
fi
echo "==> case 4.1: confirmed A=failed"

STB=$(invoker_e2e_task_status e2e-g441-taskB)
if [ "$STB" != "pending" ]; then
  echo "FAIL case 4.1: expected B=pending after submit, got '$STB'"
  exit 1
fi
echo "==> case 4.1: confirmed B=pending"

echo "==> case 4.1: fix A (claude-marker.sh runs)"
invoker_e2e_run_headless fix e2e-g441-taskA

STA=$(invoker_e2e_task_status e2e-g441-taskA)
if [ "$STA" != "awaiting_approval" ]; then
  echo "FAIL case 4.1: expected A=awaiting_approval after fix, got '$STA'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 4.1: confirmed A=awaiting_approval"

echo "==> case 4.1: approve A"
invoker_e2e_run_headless approve e2e-g441-taskA

STA=$(invoker_e2e_task_status e2e-g441-taskA)
STB=$(invoker_e2e_task_status e2e-g441-taskB)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ]; then
  echo "FAIL case 4.1: expected A=completed B=completed, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 4.1 (fix A → approve → A=completed, B=completed)"
