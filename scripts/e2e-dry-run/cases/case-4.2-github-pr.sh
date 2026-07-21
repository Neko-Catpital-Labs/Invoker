#!/usr/bin/env bash
# Group 4.2 — mergeMode=github creates a PR via stub gh CLI.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 4.2: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 4.2: submit plan (mergeMode=github)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group4-fix-merge/4.2-github-pr.yaml"

STA=$(invoker_e2e_task_status e2e-g442-taskA)
STB=$(invoker_e2e_task_status e2e-g442-taskB)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ]; then
  echo "FAIL case 4.2: expected A=completed B=completed, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 4.2: confirmed A=completed, B=completed"

# Extract merge gate task ID. The orchestrator creates it as __merge__<workflowId>.
# We find the workflow ID by looking for a task matching the __merge__ prefix.
MERGE_ID=$(invoker_e2e_merge_gate_id)
if [ -z "$MERGE_ID" ]; then
  echo "FAIL case 4.2: could not find merge gate task ID"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 4.2: merge gate ID=$MERGE_ID"

STM=$(invoker_e2e_task_status "$MERGE_ID")
if [ "$STM" != "awaiting_approval" ] && [ "$STM" != "review_ready" ]; then
  echo "FAIL case 4.2: expected merge gate=awaiting_approval|review_ready, got '$STM'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 4.2: confirmed merge gate status=$STM"

# Verify gh stub was called with expected operations
GHLOG="$INVOKER_E2E_MARKER_ROOT/gh-calls.log"
if [ ! -f "$GHLOG" ]; then
  echo "FAIL case 4.2: gh stub log not found at $GHLOG"
  exit 1
fi

if ! grep -q "api.*repos.*pulls.*GET" "$GHLOG"; then
  echo "FAIL case 4.2: gh stub log missing REST PR lookup call"
  cat "$GHLOG"
  exit 1
fi
echo "==> case 4.2: confirmed REST PR lookup was called"

if ! grep -q "api.*repos.*pulls.*POST" "$GHLOG"; then
  echo "FAIL case 4.2: gh stub log missing PR creation API call"
  cat "$GHLOG"
  exit 1
fi
echo "==> case 4.2: confirmed gh PR creation API was called"

# A github-mode merge gate completes only when every required PR is MERGED
# (orchestrator.assertReviewGateApprovable). Simulate the operator merging the
# stub PR, then run the pr-status worker so the poll reconciles the required
# artifact to approved and the gate lands. This is the production path: a github
# gate is finished by the PR-status poll, not by a manual approve on an open PR.
echo "==> case 4.2: merge stub PR + reconcile via pr-status worker"
touch "$INVOKER_E2E_MARKER_ROOT/pr-merged"
for _ in $(seq 1 120); do
  invoker_e2e_run_headless worker pr-status >/dev/null 2>&1 || true
  STM=$(invoker_e2e_task_status "$MERGE_ID")
  if [ "$STM" = "completed" ]; then
    break
  fi
  sleep 2
done

if [ "$STM" != "completed" ]; then
  echo "FAIL case 4.2: expected merge gate=completed after PR merge, got '$STM'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 4.2 (mergeMode=github: tasks completed, PR created, gate approved)"
