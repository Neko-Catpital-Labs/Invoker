#!/usr/bin/env bash
set -euo pipefail

# Repro: a task deferred because its execution pool has no member capacity
# (`reason: 'resource-limit'`) must wait in line and heartbeat instead of being
# reset + re-dispatched on every ~4s scheduler poll. The unfixed defer/abandon
# loop reset the task to pending, minted a fresh attempt, and abandoned the
# launch-dispatch row with `task deferred` on every poll — hundreds of abandoned
# rows per task in production while the SSH pool was momentarily full.
#
# Runs the focused workflow-core regression. On the unfixed tree the parked-defer
# spec is marked `it.fails` (the task IS re-dispatched immediately); the fix slice
# flips it to a passing `it` plus slot-free / backoff-elapsed coverage.

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

pnpm --filter @invoker/workflow-core exec vitest run \
  src/__tests__/orchestrator-gates-and-workflow-admin.test.ts \
  -t "resource-limit"
