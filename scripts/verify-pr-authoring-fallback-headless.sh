#!/usr/bin/env bash
# End-to-end headless verification: PR-authoring fallback chain via external_review.
#
# Submits plans/verify-pr-authoring-fallback-headless.yaml with mergeMode=external_review.
# Stub agent binaries (claude-marker.sh, codex-marker.sh) force the canonical
# no-AI fallback because they produce no valid PR body output.
#
# Asserts:
#   1. Both command tasks reach "completed".
#   2. The merge gate reaches "awaiting_approval" or "review_ready".
#   3. The gh stub was called with REST PR lookup and a PR creation API call.
#   4. The PR body passed to gh contains the canonical sections:
#      ## Summary, ## Test Plan, ## Revert Plan.
#
# Uses the e2e-dry-run common library for environment isolation (temp DB,
# marker stubs, repo URL rewriting).
#
# Usage (from repo root): bash scripts/verify-pr-authoring-fallback-headless.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-dry-run/lib/common.sh"

invoker_e2e_ensure_app_built
invoker_e2e_init
trap invoker_e2e_cleanup EXIT

unset ELECTRON_RUN_AS_NODE

echo "==> verify-pr-authoring-fallback: delete-all"
invoker_e2e_run_headless delete-all

echo "==> verify-pr-authoring-fallback: submit plan (mergeMode=external_review)"
invoker_e2e_submit_plan "$ROOT/plans/verify-pr-authoring-fallback-headless.yaml"

# ── Assert 1: command tasks completed ──────────────────────

STA=$(invoker_e2e_task_status verify-pr-fallback-taskA)
STB=$(invoker_e2e_task_status verify-pr-fallback-taskB)
if [ "$STA" != "completed" ] || [ "$STB" != "completed" ]; then
  echo "FAIL: expected taskA=completed taskB=completed, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "PASS: both command tasks completed (A=$STA, B=$STB)"

# ── Assert 2: merge gate reached awaiting_approval or review_ready ─

MERGE_ID=$(invoker_e2e_merge_gate_id)
if [ -z "$MERGE_ID" ]; then
  echo "FAIL: could not find merge gate task ID"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> merge gate ID=$MERGE_ID"

STM=$(invoker_e2e_task_status "$MERGE_ID")
if [ "$STM" != "awaiting_approval" ] && [ "$STM" != "review_ready" ]; then
  echo "FAIL: expected merge gate=awaiting_approval|review_ready, got '$STM'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "PASS: merge gate status=$STM"

# ── Assert 3: gh stub was invoked for REST PR lookup + PR creation ────────

GHLOG="$INVOKER_E2E_MARKER_ROOT/gh-calls.log"
if [ ! -f "$GHLOG" ]; then
  echo "FAIL: gh stub log not found at $GHLOG"
  exit 1
fi

if ! grep -q "api.*repos.*pulls.*GET" "$GHLOG"; then
  echo "FAIL: gh stub log missing REST PR lookup call"
  cat "$GHLOG"
  exit 1
fi
echo "PASS: REST PR lookup was called"

if ! grep -q "api.*repos.*pulls.*POST" "$GHLOG"; then
  echo "FAIL: gh stub log missing PR creation API call"
  cat "$GHLOG"
  exit 1
fi
echo "PASS: gh PR creation API was called"

# ── Assert 4: canonical PR body contains required sections ─────────
# The body is passed to gh via: -f body=<content>
# The gh-marker.sh logs "gh $*" which expands the multi-line body across
# multiple log lines. Search the full log for required canonical sections.

for section in "## Summary" "## Test Plan" "## Revert Plan"; do
  if ! grep -qF "$section" "$GHLOG"; then
    echo "FAIL: PR body missing required section: $section"
    cat "$GHLOG"
    exit 1
  fi
done
echo "PASS: canonical PR body contains ## Summary, ## Test Plan, ## Revert Plan"

# ── Assert 5: test plan references completed command tasks ─────────
# The canonical fallback emits "[x] \`<command>\`" for completed command tasks.

if ! grep -qF "verify-pr-fallback-ok-a" "$GHLOG"; then
  echo "FAIL: PR body missing evidence for taskA command"
  cat "$GHLOG"
  exit 1
fi
if ! grep -qF "verify-pr-fallback-ok-b" "$GHLOG"; then
  echo "FAIL: PR body missing evidence for taskB command"
  cat "$GHLOG"
  exit 1
fi
echo "PASS: canonical test plan references both command task markers"

echo ""
echo "verify-pr-authoring-fallback-headless: ALL CHECKS PASSED"
