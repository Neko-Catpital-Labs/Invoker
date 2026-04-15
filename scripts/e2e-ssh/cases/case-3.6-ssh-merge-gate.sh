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
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-ssh/3.6-ssh-merge-gate.yaml"

STA=$(invoker_e2e_task_status e2e-g336-taskA)
STB=$(invoker_e2e_task_status e2e-g336-taskB)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ]; then
  echo "FAIL case 3.6: expected A=completed B=completed, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 3.6: confirmed A=completed, B=completed"

# Extract merge gate task ID.
MERGE_ID=$(invoker_e2e_merge_gate_id)
if [ -z "$MERGE_ID" ]; then
  echo "FAIL case 3.6: could not find merge gate task ID"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 3.6: merge gate ID=$MERGE_ID"

STM=$(invoker_e2e_task_status "$MERGE_ID")
if [ "$STM" != "review_ready" ]; then
  echo "FAIL case 3.6: expected merge gate=review_ready, got '$STM'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 3.6: confirmed merge gate=review_ready"

# Verify gh stub was called with expected operations.
GHLOG="$INVOKER_E2E_MARKER_ROOT/gh-calls.log"
if [ ! -f "$GHLOG" ]; then
  echo "FAIL case 3.6: gh stub log not found at $GHLOG"
  exit 1
fi

if ! grep -q "pr list" "$GHLOG"; then
  echo "FAIL case 3.6: gh stub log missing 'pr list' call"
  cat "$GHLOG"
  exit 1
fi
echo "==> case 3.6: confirmed gh pr list was called"

if ! grep -q "api.*repos.*pulls.*POST" "$GHLOG"; then
  echo "FAIL case 3.6: gh stub log missing PR creation API call"
  cat "$GHLOG"
  exit 1
fi
echo "==> case 3.6: confirmed gh PR creation API was called"

echo "==> case 3.6: approve merge gate"
invoker_e2e_run_headless approve "$MERGE_ID"

STM=$(invoker_e2e_task_status "$MERGE_ID")
if [ "$STM" != "completed" ]; then
  echo "FAIL case 3.6: expected merge gate=completed after approve, got '$STM'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 3.6 (SSH merge gate: mixed executors, PR created, gate approved)"
