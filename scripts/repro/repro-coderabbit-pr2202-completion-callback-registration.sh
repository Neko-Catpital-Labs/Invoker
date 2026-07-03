#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] verifying Crabbox cleanup helper registers completion before delivering response"
if pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "stops the lease on success" \
  --reporter=verbose; then
  echo "PASS: completion response reaches the registered callback"
else
  echo "FAIL: completion response can be skipped before callback registration" >&2
  exit 1
fi
