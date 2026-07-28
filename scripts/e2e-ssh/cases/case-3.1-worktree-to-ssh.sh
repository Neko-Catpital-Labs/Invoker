#!/usr/bin/env bash
# Group 3.1 — worktree → SSH sequential: A writes marker, B reads via SSH.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/ssh-common.sh"

invoker_e2e_ssh_init
trap invoker_e2e_ssh_full_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 3.1: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 3.1: submit plan"
# The manual merge gate stops at review_ready; this case owns the task handoff
# assertions below, not final gate approval.
SUBMIT_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-ssh-3.1-submit.XXXXXX")"
invoker_e2e_submit_plan_capture "$INVOKER_E2E_REPO_ROOT/plans/e2e-ssh/3.1-worktree-to-ssh.yaml" "$SUBMIT_LOG" || true
WF_ID="$(invoker_e2e_extract_workflow_id_from_log "$SUBMIT_LOG")"
if [ -z "$WF_ID" ]; then
  echo "FAIL case 3.1: could not extract workflow ID from submit output"
  rm -f "$SUBMIT_LOG"
  invoker_e2e_run_headless query tasks 2>&1 || true
  exit 1
fi

STA=$(invoker_e2e_task_status_from_log "$SUBMIT_LOG" "$WF_ID/e2e-g331-taskA" || true)
STB=$(invoker_e2e_task_status_from_log "$SUBMIT_LOG" "$WF_ID/e2e-g331-taskB" || true)
rm -f "$SUBMIT_LOG"
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ]; then
  echo "FAIL case 3.1: expected A=completed B=completed, got A='$STA' B='$STB'"
  invoker_e2e_run_headless query tasks 2>&1 || true
  exit 1
fi

echo "PASS case 3.1 (worktree→SSH: A=completed, B=completed)"
