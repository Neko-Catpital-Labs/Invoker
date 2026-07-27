#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_NAME='records failed submission without burning the in-memory retry budget'
if pnpm --filter @invoker/execution-engine test -- src/__tests__/pr-ci-workers.test.ts -t "$TEST_NAME"; then
  echo "[repro] PASS: CI failure submit errors do not burn the in-memory retry budget."
  exit 0
fi

echo "[repro] FAIL: CI failure submit errors still burn the in-memory retry budget or skip the failure record." >&2
exit 1
