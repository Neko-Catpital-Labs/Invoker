#!/usr/bin/env bash
# Group 1.2 — command fails (task failed, workflow failed).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

invoker_e2e_run_headless delete-all
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group1-single-task/1.2-failure.yaml" || true

ST=$(invoker_e2e_task_status e2e-g112-task)
if [ "$ST" != "failed" ]; then
  echo "FAIL case 1.2: expected e2e-g112-task status=failed, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 1.2 (e2e-g112-task failed)"
