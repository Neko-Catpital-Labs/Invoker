#!/usr/bin/env bash
set -euo pipefail

# Repro for CodeRabbit PR #1403 review finding (discussion r3458135329):
#
#   "Persist lease metadata immediately after successful resolution."
#
# TaskRunner resolves a Crabbox lease (the machine is now leased on the
# provider), then acquires a pool lease and calls executor.start(). Lease
# metadata was only persisted onto the task AFTER a successful start. If the
# launch is abandoned after resolution — pool lease denied or executor.start()
# fails — the leased box is never recorded in task state, so cleanup/restart
# flows cannot find and stop it and the lease leaks until its TTL.
#
# The regression test drives a real TaskRunner with a succeeding resolver and an
# SSH executor whose start() rejects, then asserts the resolved lease id was
# persisted to the task. On the buggy code nothing is persisted (no lease write);
# the fix persists the lease immediately after resolution.
#
# Exits NON-ZERO on the buggy behavior (test fails), zero once fixed.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_FILE="src/__tests__/crabbox-lease-metadata-persistence.test.ts"

echo "[repro] pr1403 crabbox lease metadata not persisted on abandoned launch"
echo "[repro] running ${TEST_FILE} in @invoker/execution-engine"

if pnpm --filter @invoker/execution-engine exec vitest run "$TEST_FILE"; then
  echo "PASS: crabbox lease metadata is persisted immediately after resolution (recoverable on abandoned launch)"
else
  echo "FAIL: crabbox lease metadata is only persisted on the success path, leaking abandoned leases" >&2
  exit 1
fi
