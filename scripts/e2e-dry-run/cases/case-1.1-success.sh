#!/usr/bin/env bash
# Group 1.1 — success path (completed worktree task).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 1.1: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 1.1: submit plan"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group1-single-task/1.1-success.yaml"

ST=$(invoker_e2e_task_status e2e-g111-task)
if [ "$ST" != "completed" ]; then
  echo "FAIL case 1.1: expected e2e-g111-task status=completed, got '$ST'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 1.1 (e2e-g111-task completed)"
