#!/usr/bin/env bash
set -euo pipefail

# Repro for CodeRabbit PR #1403 review finding (discussion r3458135315):
#
#   "Make resolved Crabbox leases launch-scoped and validity-aware."
#
# TaskRunner keeps a single in-memory lease per crabbox target in
# `resolvedCrabboxTargets` (keyed by targetId). When two tasks on the SAME
# crabbox target resolve concurrently, both miss the shared map, both call the
# resolver, and each is handed its own lease. The second resolution overwrites
# the shared map AFTER the first launch already built its executor from its own
# lease. The first launch then persists/logs metadata read back from the shared
# map — the OTHER launch's lease — so cleanup/restore later targets the wrong
# leased box.
#
# The regression test drives a real TaskRunner and forces that exact
# interleaving (gated resolver + gated executor.start on the first launch), then
# asserts each launch persists ITS OWN lease id. On the buggy code the first
# launch's success-path metadata write records the second launch's lease id.
# The fix binds the resolved lease to the launch's pending pool selection and
# reads it (not the shared map) for resource keys, logs, and persistence.
#
# Exits NON-ZERO on the buggy behavior (test fails), zero once fixed.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_FILE="src/__tests__/crabbox-concurrent-lease-metadata-mismatch.test.ts"

echo "[repro] pr1403 crabbox lease not launch-scoped (concurrent metadata mismatch)"
echo "[repro] running ${TEST_FILE} in @invoker/execution-engine"

if pnpm --filter @invoker/execution-engine exec vitest run "$TEST_FILE"; then
  echo "PASS: each concurrent same-target launch persists its own crabbox lease (launch-scoped)"
else
  echo "FAIL: a launch persists another concurrent launch's lease via the shared resolvedCrabboxTargets map" >&2
  exit 1
fi
