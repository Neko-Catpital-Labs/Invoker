#!/usr/bin/env bash
# Group 2.10 — cancel running task A, downstream B stays pending.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 2.10: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 2.10: submit plan (background — sleep 60 blocks)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.10-cancel-downstream.yaml" &
BG_PID=$!

# Poll until task A reaches "running" (max 30s).
echo "==> case 2.10: waiting for task A to reach running"
for i in $(seq 1 30); do
  ST=$(invoker_e2e_task_status e2e-g2210-taskA 2>/dev/null || true)
  if [ "$ST" = "running" ]; then
    echo "==> case 2.10: task A is running (poll $i)"
    break
  fi
  sleep 1
done

echo "==> case 2.10: cancel task A"
invoker_e2e_run_headless cancel e2e-g2210-taskA

if ! invoker_e2e_wait_task_status e2e-g2210-taskA failed 60; then
  STA=$(invoker_e2e_task_status e2e-g2210-taskA 2>/dev/null || true)
  echo "FAIL case 2.10: expected A=failed, got A='$STA'"
  invoker_e2e_run_headless status 2>&1 || true
  kill "$BG_PID" 2>/dev/null || true
  wait "$BG_PID" 2>/dev/null || true
  exit 1
fi

STB=$(invoker_e2e_task_status e2e-g2210-taskB)
# B may be 'failed' (cascade cancel) or 'pending' (not yet cascaded) — both valid.
if [ "$STB" != "failed" ] && [ "$STB" != "pending" ]; then
  echo "FAIL case 2.10: expected B=failed|pending, got B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  kill "$BG_PID" 2>/dev/null || true
  wait "$BG_PID" 2>/dev/null || true
  exit 1
fi

# Reap background submit-plan process (may already have exited after cancel).
kill "$BG_PID" 2>/dev/null || true
wait "$BG_PID" 2>/dev/null || true

echo "PASS case 2.10 (cancel A → A=failed, B=$STB)"
