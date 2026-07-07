#!/usr/bin/env bash
# Repro: review-gate CI auto-fix intents die at dispatch with
#
#   Error: Task __merge__wf-... is not failed (status: review_ready)
#       at beginConflictResolutionImpl
#       at fixWithAgentAction
#       at executeFixWithAgentMutation
#
# Root cause guarded here:
#   A merge gate whose review PR has a red CI check stays `review_ready` — the
#   gate task itself never failed. The ci-failure worker intentionally targets
#   gates in review_ready/awaiting_approval (staleReasonForEvent), but the fix
#   action entered the lifecycle through a failed-only guard. Every
#   review-gate CI repair intent therefore failed within milliseconds of being
#   queued, so "Fix with <agent>" appeared queued but never executed.
#
# Fixed behavior:
#   Fix sessions have an explicit entry-state allow-list (failed,
#   review_ready, awaiting_approval). `beginFixSession` records the entry
#   status on the task, and every exit — agent failure, reject, invalid
#   workspace — restores the recorded entry via `revertFixSession`, so an open
#   review gate returns to the review-polling loop instead of being flipped to
#   failed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] app: review-gate CI fix must start from a review_ready merge gate and revert there"
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/repro-review-gate-ci-fix-review-ready.test.ts

echo "[repro] passed"
