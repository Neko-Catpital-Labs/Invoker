#!/usr/bin/env bash
# Group 4.3 — fix A → approve → downstream B completes → merge gate creates PR.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 4.3: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 4.3: submit plan (task A will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group4-fix-merge/4.3-fix-then-pr.yaml" || true
invoker_e2e_wait_settled e2e-g443-taskA

STA=$(invoker_e2e_task_status e2e-g443-taskA)
if [ "$STA" != "failed" ]; then
  echo "FAIL case 4.3: expected A=failed after submit, got '$STA'"
  exit 1
fi
echo "==> case 4.3: confirmed A=failed"

echo "==> case 4.3: fix A (claude-marker.sh runs)"
invoker_e2e_run_headless fix e2e-g443-taskA
invoker_e2e_wait_settled e2e-g443-taskA

STA=$(invoker_e2e_task_status e2e-g443-taskA)
if [ "$STA" != "awaiting_approval" ]; then
  echo "FAIL case 4.3: expected A=awaiting_approval after fix, got '$STA'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 4.3: confirmed A=awaiting_approval"

echo "==> case 4.3: approve A"
invoker_e2e_run_headless approve e2e-g443-taskA
invoker_e2e_wait_settled e2e-g443-taskA
invoker_e2e_wait_settled e2e-g443-taskB

STA=$(invoker_e2e_task_status e2e-g443-taskA)
STB=$(invoker_e2e_task_status e2e-g443-taskB)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ]; then
  echo "FAIL case 4.3: expected A=completed B=completed, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 4.3: confirmed A=completed, B=completed"

# Extract merge gate task ID
MERGE_ID=$(invoker_e2e_merge_gate_id)
if [ -z "$MERGE_ID" ]; then
  echo "FAIL case 4.3: could not find merge gate task ID"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 4.3: merge gate ID=$MERGE_ID"

# headlessApprove exits before the merge gate finishes (it only awaits the
# directly started tasks, not cascading merge nodes). The merge gate is left in
# "running" state with its work interrupted. Resume the workflow so the merge
# gate is detected as orphaned, restarted, and runs to completion.
WF_ID="${MERGE_ID#__merge__}"
echo "==> case 4.3: resume workflow $WF_ID to let merge gate run"
invoker_e2e_run_headless resume "$WF_ID"
invoker_e2e_wait_settled "$MERGE_ID"

STM=$(invoker_e2e_task_status "$MERGE_ID")
if [ "$STM" != "awaiting_approval" ] && [ "$STM" != "review_ready" ]; then
  echo "FAIL case 4.3: expected merge gate=awaiting_approval|review_ready, got '$STM'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 4.3: confirmed merge gate status=$STM"

# Verify gh stub was called with PR creation
GHLOG="$INVOKER_E2E_MARKER_ROOT/gh-calls.log"
if [ ! -f "$GHLOG" ]; then
  echo "FAIL case 4.3: gh stub log not found at $GHLOG"
  exit 1
fi

if ! grep -q "pr list" "$GHLOG"; then
  echo "FAIL case 4.3: gh stub log missing 'pr list' call"
  cat "$GHLOG"
  exit 1
fi

if ! grep -q "api.*repos.*pulls.*POST" "$GHLOG"; then
  echo "FAIL case 4.3: gh stub log missing PR creation API call"
  cat "$GHLOG"
  exit 1
fi
echo "==> case 4.3: confirmed gh PR creation calls in stub log"

echo "==> case 4.3: approve merge gate"
invoker_e2e_run_headless approve "$MERGE_ID"
invoker_e2e_wait_settled "$MERGE_ID"

STM=$(invoker_e2e_task_status "$MERGE_ID")
if [ "$STM" != "completed" ]; then
  echo "FAIL case 4.3: expected merge gate=completed after approve, got '$STM'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS case 4.3 (fix A → approve → B completed → PR created → gate approved)"
