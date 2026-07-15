#!/usr/bin/env bash
set -euo pipefail

# Repro for the still-valid part of CodeRabbit PR #1403 discussion r3458135315:
# the shared Crabbox lease cache must be invalidated on config drift / expiry,
# and restart-time remote target lookup must fall back to persisted lease
# metadata when the in-memory cache is gone.
#
# Exits NON-ZERO on the buggy behavior (test fails), zero once fixed.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_FILE="src/__tests__/crabbox-resolved-target-validity.test.ts"

echo "[repro] pr1403 crabbox cache validity and restart hydration"
echo "[repro] running ${TEST_FILE} in @invoker/execution-engine"

if pnpm --filter @invoker/execution-engine exec vitest run "$TEST_FILE"; then
  echo "PASS: crabbox cache re-resolves on drift/expiry and restart rehydrates the leased ssh endpoint"
else
  echo "FAIL: crabbox cache reused a stale lease or restart-time remote target lookup lost the leased endpoint" >&2
  exit 1
fi
