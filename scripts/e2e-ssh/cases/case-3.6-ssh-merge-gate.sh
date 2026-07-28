#!/usr/bin/env bash
# Group 3.6 — merge gate with mixed executors (worktree + SSH) → PR created.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/ssh-common.sh"

invoker_e2e_ssh_init
trap invoker_e2e_ssh_full_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 3.6: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 3.6: submit plan (mergeMode=github, mixed executors)"
SUBMIT_LOG="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-ssh-3.6-submit.XXXXXX")"
invoker_e2e_submit_plan_capture "$INVOKER_E2E_REPO_ROOT/plans/e2e-ssh/3.6-ssh-merge-gate.yaml" "$SUBMIT_LOG" || true
WF_ID="$(invoker_e2e_extract_workflow_id_from_log "$SUBMIT_LOG")"
if [ -z "$WF_ID" ]; then
  echo "FAIL case 3.6: could not extract workflow ID from submit output"
  rm -f "$SUBMIT_LOG"
  invoker_e2e_run_headless query tasks 2>&1 || true
  exit 1
fi
TASK_A="$WF_ID/e2e-g336-taskA"
TASK_B="$WF_ID/e2e-g336-taskB"
MERGE_ID="__merge__$WF_ID"

STA=$(invoker_e2e_task_status_from_log "$SUBMIT_LOG" "$TASK_A" || true)
STB=$(invoker_e2e_task_status_from_log "$SUBMIT_LOG" "$TASK_B" || true)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ]; then
  echo "FAIL case 3.6: expected A=completed B=completed, got A='$STA' B='$STB'"
  rm -f "$SUBMIT_LOG"
  invoker_e2e_run_headless query tasks 2>&1 || true
  exit 1
fi
echo "==> case 3.6: confirmed A=completed, B=completed"
echo "==> case 3.6: merge gate ID=$MERGE_ID"

STM=$(invoker_e2e_task_status_from_log "$SUBMIT_LOG" "$MERGE_ID" || true)
rm -f "$SUBMIT_LOG"
if [ "$STM" != "review_ready" ]; then
  echo "FAIL case 3.6: expected merge gate=review_ready, got '$STM'"
  invoker_e2e_run_headless query tasks 2>&1 || true
  exit 1
fi
echo "==> case 3.6: confirmed merge gate=review_ready"

# Verify gh stub was called with expected operations.
GHLOG="$INVOKER_E2E_MARKER_ROOT/gh-calls.log"
if [ ! -f "$GHLOG" ]; then
  echo "FAIL case 3.6: gh stub log not found at $GHLOG"
  exit 1
fi

if ! grep -q "api.*repos.*pulls.*GET" "$GHLOG"; then
  echo "FAIL case 3.6: gh stub log missing REST PR lookup call"
  cat "$GHLOG"
  exit 1
fi
echo "==> case 3.6: confirmed REST PR lookup was called"

if ! grep -q "api.*repos.*pulls.*POST" "$GHLOG"; then
  echo "FAIL case 3.6: gh stub log missing PR creation API call"
  cat "$GHLOG"
  exit 1
fi
echo "==> case 3.6: confirmed gh PR creation API was called"

# A github-mode merge gate completes only when every required PR is MERGED
# (orchestrator.assertReviewGateApprovable). Simulate the operator merging the
# stub PR, then run the pr-status worker so the poll reconciles the required
# artifact to approved and the gate lands. This is the production path: a github
# gate is finished by the PR-status poll, not by a manual approve on an open PR.
echo "==> case 3.6: merge stub PR + reconcile via pr-status worker"
touch "$INVOKER_E2E_MARKER_ROOT/pr-merged"
for _ in $(seq 1 12); do
  invoker_e2e_run_headless worker pr-status >/dev/null 2>&1 || true
  STM=$(invoker_e2e_task_status "$MERGE_ID" || true)
  if [ "$STM" = "completed" ]; then
    break
  fi
  sleep 1
done

STM=$(invoker_e2e_task_status "$MERGE_ID" || true)
if [ "$STM" != "completed" ]; then
  echo "FAIL case 3.6: expected merge gate=completed after PR merge, got '$STM'"
  invoker_e2e_run_headless query tasks 2>&1 || true
  exit 1
fi

echo "PASS case 3.6 (SSH merge gate: mixed executors, PR created, gate approved)"
