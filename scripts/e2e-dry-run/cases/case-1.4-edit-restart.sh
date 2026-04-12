#!/usr/bin/env bash
# Group 1.4 — fail then edit+restart to success.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 1.4: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 1.4: submit plan (task will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group1-single-task/1.4-edit-restart.yaml" || true

ST=$(invoker_e2e_task_status e2e-g114-task)
if [ "$ST" != "failed" ]; then
  echo "FAIL case 1.4: expected intermediate status=failed, got '$ST'"
  exit 1
fi
echo "==> case 1.4: confirmed intermediate status=failed"

echo "==> case 1.4: edit command + restart"
invoker_e2e_run_headless edit e2e-g114-task echo ok

ST=$(invoker_e2e_task_status e2e-g114-task)
if [ "$ST" != "completed" ]; then
  echo "FAIL case 1.4: expected final status=completed, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 1.4 (e2e-g114-task edit+restart → completed)"
