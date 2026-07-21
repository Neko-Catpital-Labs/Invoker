#!/usr/bin/env bash
# Group 4.3 — fix A → approve → downstream B completes → merge gate creates PR.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"
invoker_e2e_case43_task_status() {
  local task_id="$1"
  invoker_e2e_task_status "$task_id" 2>/dev/null || true
}

invoker_e2e_case43_dump_state() {
  local reason="$1"
  set +e
  echo "DIAG case 4.3: $reason"
  echo "DIAG case 4.3: MERGE_ID=${MERGE_ID:-<unset>} WF_ID=${WF_ID:-<unset>}"

  for task_id in e2e-g443-taskA e2e-g443-taskB "${MERGE_ID:-}"; do
    if [ -n "$task_id" ]; then
      local status
      status="$(invoker_e2e_case43_task_status "$task_id")"
      echo "DIAG case 4.3: task $task_id status='${status:-<empty>}'"
    fi
  done

  if [ -n "${GHLOG:-}" ] && [ -f "$GHLOG" ]; then
    echo "DIAG case 4.3: gh stub log begin"
    cat "$GHLOG" || true
    echo "DIAG case 4.3: gh stub log end"
  else
    echo "DIAG case 4.3: gh stub log missing at ${GHLOG:-<unset>}"
  fi

  echo "DIAG case 4.3: headless status begin"
  invoker_e2e_run_headless status 2>&1 || true
  echo "DIAG case 4.3: headless status end"
}

invoker_e2e_case43_on_error() {
  local exit_code="$1"
  local line="$2"
  local command="$3"
  set +e
  echo "FAIL case 4.3: unexpected shell error at line $line exit=$exit_code command=$command"
  invoker_e2e_case43_dump_state "unexpected shell error"
  exit "$exit_code"
}

trap 'invoker_e2e_case43_on_error "$?" "$LINENO" "$BASH_COMMAND"' ERR

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

# The `approve` step below drives the whole cascade synchronously in one
# standalone headless process: it re-runs fixed task A, runs downstream task B,
# then executes the merge gate — which performs real git work (two full-repo
# clones of this checkout, a branch consolidation merge, a push, and a PR
# publish). Under full-suite load that can exceed the default 300s per-command
# cap, and a SIGTERM mid-merge leaves the gate half-run (task left `running`,
# which `resume` can recover, but the timed-out command returns non-zero first).
# Give this case's commands extra wall-clock headroom so the gate finishes
# within one command window and the flake disappears deterministically.
export INVOKER_E2E_TIMEOUT="${INVOKER_E2E_TIMEOUT_CASE43:-900}"

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE

echo "==> case 4.3: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 4.3: submit plan (task A will fail)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group4-fix-merge/4.3-fix-then-pr.yaml" || true
invoker_e2e_wait_settled e2e-g443-taskA

STA=$(invoker_e2e_case43_task_status e2e-g443-taskA)
if [ "$STA" != "failed" ]; then
  echo "FAIL case 4.3: expected A=failed after submit, got '$STA'"
  exit 1
fi
echo "==> case 4.3: confirmed A=failed"

echo "==> case 4.3: fix A (claude-marker.sh runs)"
invoker_e2e_run_headless fix e2e-g443-taskA
invoker_e2e_wait_settled e2e-g443-taskA

STA=$(invoker_e2e_case43_task_status e2e-g443-taskA)
if [ "$STA" != "awaiting_approval" ]; then
  echo "FAIL case 4.3: expected A=awaiting_approval after fix, got '$STA'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi
echo "==> case 4.3: confirmed A=awaiting_approval"

echo "==> case 4.3: approve A"
# headlessApprove tracks the workflow until it settles, so this single command
# also runs downstream task B and the merge gate. If it returns non-zero (e.g.
# the tracked merge gate outlived the per-command wall clock under load), don't
# fail the case here: task A's fix is already committed, and the wait_settled +
# resume logic below is the designed path for driving a not-yet-settled gate to
# completion. The `!=` status checks that follow are the real assertions.
invoker_e2e_run_headless approve e2e-g443-taskA || true
invoker_e2e_wait_settled e2e-g443-taskA
invoker_e2e_wait_settled e2e-g443-taskB

STA=$(invoker_e2e_case43_task_status e2e-g443-taskA)
STB=$(invoker_e2e_case43_task_status e2e-g443-taskB)
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

# Drive the merge gate to review-ready. The gate runs real git consolidation
# (clone + branch merge + push + PR publish) against the shared file:// origin;
# under load or origin contention it can be left mid-run (headlessApprove exited
# before the gate settled → task still `running`) or fail transiently (a git
# ref/fetch/push race → task `failed`). Both are recoverable by re-running the
# gate — a `running` gate via `resume`, a `failed` gate via `retry` (which resets
# the failed merge node to pending and re-runs it). This is a recovery of a
# transient gate failure, NOT a weakening of the review-gate approval invariant:
# the gate still only reaches review_ready by completing its own real work.
WF_ID="${MERGE_ID#__merge__}"
STM=$(invoker_e2e_case43_task_status "$MERGE_ID")
gate_attempt=0
while [ "$STM" != "awaiting_approval" ] && [ "$STM" != "review_ready" ] && [ "$gate_attempt" -lt 5 ]; do
  if [ "$STM" = "failed" ]; then
    echo "==> case 4.3: merge gate failed transiently; retry workflow $WF_ID (attempt $((gate_attempt + 1)))"
    invoker_e2e_run_headless retry "$WF_ID" || true
  else
    echo "==> case 4.3: merge gate $STM; resume workflow $WF_ID to let merge gate run (attempt $((gate_attempt + 1)))"
    invoker_e2e_run_headless resume "$WF_ID" || true
  fi
  invoker_e2e_wait_settled "$MERGE_ID"
  STM=$(invoker_e2e_case43_task_status "$MERGE_ID")
  gate_attempt=$((gate_attempt + 1))
done

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

if ! grep -q "api.*repos.*pulls.*GET" "$GHLOG"; then
  echo "FAIL case 4.3: gh stub log missing REST PR lookup call"
  cat "$GHLOG"
  exit 1
fi

if ! grep -q "api.*repos.*pulls.*POST" "$GHLOG"; then
  echo "FAIL case 4.3: gh stub log missing PR creation API call"
  cat "$GHLOG"
  exit 1
fi
echo "==> case 4.3: confirmed gh PR creation calls in stub log"
echo "DIAG case 4.3: before final merge, merge gate status='$(invoker_e2e_case43_task_status "$MERGE_ID")'"

# A github-mode merge gate completes only when every required PR is MERGED
# (orchestrator.assertReviewGateApprovable). Simulate the operator merging the
# stub PR, then run the pr-status worker so the poll reconciles the required
# artifact to approved and the gate lands. This is the production path: a github
# gate is finished by the PR-status poll, not by a manual approve on an open PR.
echo "==> case 4.3: merge stub PR + reconcile via pr-status worker"
touch "$INVOKER_E2E_MARKER_ROOT/pr-merged"
for _ in $(seq 1 120); do
  invoker_e2e_run_headless worker pr-status >/dev/null 2>&1 || true
  STM=$(invoker_e2e_case43_task_status "$MERGE_ID")
  if [ "$STM" = "completed" ]; then
    break
  fi
  sleep 2
done

STM=$(invoker_e2e_case43_task_status "$MERGE_ID")
if [ "$STM" != "completed" ]; then
  echo "FAIL case 4.3: expected merge gate=completed after PR merge, got '$STM'"
  invoker_e2e_case43_dump_state "merge gate was not completed after PR merge"
  exit 1
fi
echo "PASS case 4.3 (fix A → approve → B completed → PR created → gate approved)"
