#!/usr/bin/env bash
# Group 3.3 — worktree → SSH → worktree chain: A writes, B reads+writes via SSH, C reads both.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/ssh-common.sh"

invoker_e2e_ssh_init
trap invoker_e2e_ssh_full_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 3.3: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 3.3: submit plan"
# The manual merge gate stops at review_ready; this case owns the task chain
# assertions below, not final gate approval.
SUBMIT_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-ssh-3.3-submit.XXXXXX")"
invoker_e2e_submit_plan_capture "$INVOKER_E2E_REPO_ROOT/plans/e2e-ssh/3.3-fix-then-ssh.yaml" "$SUBMIT_LOG" || true
WF_ID="$(invoker_e2e_extract_workflow_id_from_log "$SUBMIT_LOG")"
if [ -z "$WF_ID" ]; then
  echo "FAIL case 3.3: could not extract workflow ID from submit output"
  rm -f "$SUBMIT_LOG"
  invoker_e2e_run_headless query tasks 2>&1 || true
  exit 1
fi

STA=$(invoker_e2e_task_status_from_log "$SUBMIT_LOG" "$WF_ID/e2e-g333-taskA" || true)
STB=$(invoker_e2e_task_status_from_log "$SUBMIT_LOG" "$WF_ID/e2e-g333-taskB" || true)
STC=$(invoker_e2e_task_status_from_log "$SUBMIT_LOG" "$WF_ID/e2e-g333-taskC" || true)
rm -f "$SUBMIT_LOG"
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ] || [ "$STC" != "completed" ]; then
  echo "FAIL case 3.3: expected all completed, got A='$STA' B='$STB' C='$STC'"
  invoker_e2e_run_headless query tasks 2>&1 || true
  exit 1
fi

echo "PASS case 3.3 (chain worktree→SSH→worktree: A,B,C all completed)"
