#!/usr/bin/env bash
# Group 1.3 — cancel a running task.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 1.3: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 1.3: submit plan (background — sleep 60 blocks)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group1-single-task/1.3-cancel.yaml" &
BG_PID=$!

# Poll until the task reaches "running" (max 30s).
echo "==> case 1.3: waiting for task to reach running"
for i in $(seq 1 30); do
  ST=$(invoker_e2e_task_status e2e-g113-task 2>/dev/null || true)
  if [ "$ST" = "running" ]; then
    echo "==> case 1.3: task is running (poll $i)"
    break
  fi
  sleep 1
done

echo "==> case 1.3: cancel task"
invoker_e2e_run_headless cancel e2e-g113-task

if ! invoker_e2e_wait_task_status e2e-g113-task failed 60; then
  ST=$(invoker_e2e_task_status e2e-g113-task 2>/dev/null || true)
  echo "FAIL case 1.3: expected e2e-g113-task status=failed, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  kill "$BG_PID" 2>/dev/null || true
  wait "$BG_PID" 2>/dev/null || true
  exit 1
fi

# Reap background submit-plan process (may already have exited after cancel killed the runner).
kill "$BG_PID" 2>/dev/null || true
wait "$BG_PID" 2>/dev/null || true

echo "PASS case 1.3 (e2e-g113-task cancelled → failed)"
