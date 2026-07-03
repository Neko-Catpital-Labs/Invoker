#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] verifying hung Crabbox stop times out during cleanup"
if pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "times out a hung Crabbox stop so completion processing continues" \
  --reporter=verbose; then
  echo "PASS: hung Crabbox stop is timed out and logged as cleanup failure"
else
  echo "FAIL: hung Crabbox stop blocked completion processing" >&2
  exit 1
fi
