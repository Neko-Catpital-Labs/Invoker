#!/usr/bin/env bash
# Repro: an "Execution stalled" liveness failure must be REQUEUED, not AI-auto-fixed.
#
# Root cause guarded here:
#   The executing-stall watchdog force-fails a task whose executor stopped
#   heartbeating with `Execution stalled: ... (attempt lease expired)`. The only
#   failure classifier (shouldSkipAutoFixForError) recognized only cancellation
#   errors, so the stall fell through to the AI fixer, which re-ran the same step,
#   re-stalled at 180s, and looped forever — a merge gate cycled fix→run→stall→
#   fix indefinitely while the machine was overloaded.
#
# Fixed behavior:
#   1. The stall guard stamps execution.failureClass='liveness_stall' (persisted).
#   2. The auto-fix engine and orchestrator.shouldAutoFix SKIP liveness failures.
#   3. A dedicated requeue worker re-runs the task via the normal `retry-task`
#      command with a bounded budget (default 3) and backoff (default 2m), then
#      escalates to needs_input once exhausted — no infinite loop.
#   4. publishAfterFix pumps the attempt heartbeat like executeMergeNode, so a
#      slow-but-alive publish is not misread as a stall in the first place.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "== requeue ledger + worker (budget / backoff / escalate) =="
( cd packages/execution-engine && npx vitest run \
    src/__tests__/requeue-attempt-ledger.test.ts \
    src/__tests__/requeue-worker.test.ts )

echo "== auto-fix excludes liveness + requeue single-engine guard =="
( cd packages/app && npx vitest run \
    src/__tests__/auto-fix-recovery.test.ts \
    src/__tests__/no-requeue-outside-worker.test.ts )

echo "== shouldAutoFix skips liveness + escalateStalledToNeedsInput =="
( cd packages/workflow-core && npx vitest run src/__tests__/orchestrator.test.ts )

echo "== failure_class persistence round-trip =="
( cd packages/data-store && npx vitest run src/__tests__/sqlite-adapter.test.ts -t "failure_class" )

echo "OK: liveness stalls are requeued (bounded) and never AI-auto-fixed."
