#!/usr/bin/env bash
# Group 3.7 — SSH target-owned provision command hydrates the managed SSH worktree.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/ssh-common.sh"

invoker_e2e_ssh_init
trap invoker_e2e_ssh_full_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

expected_provision_cmd="$(invoker_e2e_ssh_config_provision_command)"
actual_provision_cmd="$(jq -r '.remoteTargets["localhost-e2e"].provisionCommand' "$INVOKER_REPO_CONFIG_PATH")"
if [ "$actual_provision_cmd" != "$expected_provision_cmd" ]; then
  echo "FAIL case 3.7: expected config provisionCommand '$expected_provision_cmd' but got '$actual_provision_cmd'"
  exit 1
fi

echo "==> case 3.7: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 3.7: submit plan"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-ssh/3.7-ssh-target-provision.yaml"

STA=$(invoker_e2e_task_status e2e-g337-taskA)
if [ "$STA" != "completed" ]; then
  echo "FAIL case 3.7: expected SSH task=completed, got '$STA'"
  invoker_e2e_run_headless query tasks 2>&1 || true
  exit 1
fi

echo "PASS case 3.7 (SSH target provisioning ran vitest in the managed worktree)"
