#!/usr/bin/env bash
# Headless verification: PR-authoring external-review fallback path.
#
# Submits plans/verify-pr-authoring-fallback-headless.yaml through
# submit-plan.sh with stub claude/gh/codex CLIs. Asserts:
#   1. Both command tasks complete.
#   2. Merge gate reaches awaiting_approval or review_ready.
#   3. The gh stub log contains PR creation calls.
#   4. The gh stub log contains the canonical PR body sections
#      (## Summary, ## Test Plan, ## Revert Plan).
#   5. Merge gate completes after approval.
#
# Uses an isolated temp DB — never touches the user's DB or calls delete-all.
#
# Usage (from repo root): bash scripts/verify-pr-authoring-fallback-headless.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# --- source e2e common helpers ---
# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-dry-run/lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

# --- ensure the app is built ---
invoker_e2e_ensure_app_built

# --- submit plan ---
PLAN_SRC="$INVOKER_E2E_REPO_ROOT/plans/verify-pr-authoring-fallback-headless.yaml"

echo "==> verify-pr-authoring: submit plan (mergeMode=external_review)"
invoker_e2e_submit_plan "$PLAN_SRC"

# --- assert both tasks completed ---
STA=$(invoker_e2e_task_status verify-pr-taskA)
STB=$(invoker_e2e_task_status verify-pr-taskB)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ]; then
  echo "FAIL: expected taskA=completed taskB=completed, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> verify-pr-authoring: confirmed taskA=completed, taskB=completed"

# --- locate merge gate ---
MERGE_ID=$(invoker_e2e_merge_gate_id)
if [ -z "$MERGE_ID" ]; then
  echo "FAIL: could not find merge gate task ID"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> verify-pr-authoring: merge gate ID=$MERGE_ID"

STM=$(invoker_e2e_task_status "$MERGE_ID")
if [ "$STM" != "awaiting_approval" ] && [ "$STM" != "review_ready" ]; then
  echo "FAIL: expected merge gate=awaiting_approval|review_ready, got '$STM'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> verify-pr-authoring: confirmed merge gate status=$STM"

# --- verify gh stub was called with PR creation ---
GHLOG="$INVOKER_E2E_MARKER_ROOT/gh-calls.log"
if [ ! -f "$GHLOG" ]; then
  echo "FAIL: gh stub log not found at $GHLOG"
  exit 1
fi

if ! grep -q "pr list" "$GHLOG"; then
  echo "FAIL: gh stub log missing 'pr list' call"
  cat "$GHLOG"
  exit 1
fi
echo "==> verify-pr-authoring: confirmed gh pr list was called"

if ! grep -q "api.*repos.*pulls.*POST" "$GHLOG"; then
  echo "FAIL: gh stub log missing PR creation API call"
  cat "$GHLOG"
  exit 1
fi
echo "==> verify-pr-authoring: confirmed gh PR creation API was called"

# --- verify canonical PR body sections in gh stub log ---
# The gh stub logs "gh api ... -f body=<body>" on a single line.
# The canonical fallback emits ## Summary, ## Test Plan, ## Revert Plan.
for section in "## Summary" "## Test Plan" "## Revert Plan"; do
  if ! grep -qF "$section" "$GHLOG"; then
    echo "FAIL: gh stub log missing canonical PR body section: $section"
    echo "--- gh-calls.log ---"
    cat "$GHLOG"
    echo "---"
    exit 1
  fi
done
echo "==> verify-pr-authoring: confirmed canonical PR body sections (Summary, Test Plan, Revert Plan)"

# --- approve merge gate and verify completion ---
echo "==> verify-pr-authoring: approve merge gate"
invoker_e2e_run_headless approve "$MERGE_ID"

STM=$(invoker_e2e_task_status "$MERGE_ID")
if [ "$STM" != "completed" ]; then
  echo "FAIL: expected merge gate=completed after approve, got '$STM'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

echo "PASS verify-pr-authoring-fallback (tasks completed, PR created with canonical body, gate approved)"
