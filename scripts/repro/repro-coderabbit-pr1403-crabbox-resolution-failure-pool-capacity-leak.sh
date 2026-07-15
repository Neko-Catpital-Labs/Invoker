#!/usr/bin/env bash
set -euo pipefail

# Repro for CodeRabbit PR #1403 review finding (discussion r3458135323):
#
#   "Clear the selected pool member if Crabbox resolution fails."
#
# TaskRunner.selectExecutor() stores a pending pool selection BEFORE it throws
# CrabboxResolutionRequiredError. executeTaskInner() then runs the async
# resolver. If crabboxResolver.resolve() (or the post-resolution executor
# build) throws, the pending selection was never released, so poolMemberLoad()
# keeps counting the dead launch and the pool member's capacity is permanently
# reduced for later tasks.
#
# The regression test drives a real TaskRunner with a rejecting resolver and a
# single-slot crabbox pool member, then asserts a second task can still be
# selected on that member. On the buggy code the leaked pending selection makes
# the member look full ("no member capacity available"); the fix releases the
# pending selection so resolution can be retried.
#
# Exits NON-ZERO on the buggy behavior (test fails), zero once fixed.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_FILE="src/__tests__/crabbox-resolution-failure-capacity.test.ts"

echo "[repro] pr1403 crabbox resolution failure pool capacity leak"
echo "[repro] running ${TEST_FILE} in @invoker/execution-engine"

if pnpm --filter @invoker/execution-engine exec vitest run "$TEST_FILE"; then
  echo "PASS: failed crabbox resolution releases the pending pool selection (capacity restored)"
else
  echo "FAIL: crabbox resolution failure leaks the pending pool selection, starving pool member capacity" >&2
  exit 1
fi
