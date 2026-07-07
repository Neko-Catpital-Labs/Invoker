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
#   gates in review_ready/awaiting_approval (staleReasonForEvent), but
#   fixWithAgentAction entered the fix lifecycle through
#   beginConflictResolution, whose guard only accepts `failed` tasks. Every
#   review-gate CI repair intent therefore failed within milliseconds of being
#   queued, so "Fix with <agent>" appeared queued but never executed.
#
# Fixed behavior:
#   Review-gate CI fixes route through beginAutoFixSession (accepts
#   review_ready/awaiting_approval), run the agent fix, and park the gate in
#   awaiting_approval. A failing agent fix restores the gate to review_ready
#   instead of flipping an open review gate to failed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] app: review-gate CI fix must start from a review_ready merge gate"
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/repro-review-gate-ci-fix-review-ready.test.ts

echo "[repro] passed"
