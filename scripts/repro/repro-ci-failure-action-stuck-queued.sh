#!/usr/bin/env bash
# Repro: a review-gate CI repair shows "queued" forever after its fix intent
# fails.
#
# Root cause guarded here:
#   The ci-failure worker records its dedupe worker action as `queued` when it
#   submits an invoker:fix-with-agent mutation intent, but nothing wrote the
#   intent's terminal outcome back to the action row. When the intent failed,
#   the action stayed `queued`; every subsequent tick skipped the same failed
#   check with
#
#     worker-ci-failure-skip reason=already-recorded existingStatus=queued
#
#   so the UI showed a repair "queued up" that never executed and the worker
#   never retried.
#
# Fixed behavior:
#   Before the dedupe check, the worker folds the terminal intent outcome back
#   into the action row: a failed intent marks the action failed and the same
#   tick requeues a fresh repair (bounded by the attempt ledger); a completed
#   intent marks the action completed; open intents keep the action deduped.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] execution-engine: failed fix intents must not leave the CI repair action queued"
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/repro-ci-failure-action-stuck-queued.test.ts

echo "[repro] passed"
