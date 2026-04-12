#!/usr/bin/env bash
# Group 1.7 — manual approval then approve.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 1.7: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 1.7: submit plan (command succeeds → awaiting_approval)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group1-single-task/1.7-manual-approve.yaml"

ST=$(invoker_e2e_task_status e2e-g117-task)
if [ "$ST" != "awaiting_approval" ]; then
  echo "FAIL case 1.7: expected status=awaiting_approval after submit, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 1.7: confirmed status=awaiting_approval"

echo "==> case 1.7: approve"
invoker_e2e_run_headless approve e2e-g117-task

ST=$(invoker_e2e_task_status e2e-g117-task)
if [ "$ST" != "completed" ]; then
  echo "FAIL case 1.7: expected status=completed after approve, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 1.7 (e2e-g117-task manual-approve → completed)"
