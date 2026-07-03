#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] verifying Crabbox cleanup runs before downstream launch"
if pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "cleans the current Crabbox lease before launching downstream tasks" \
  --reporter=verbose; then
  echo "PASS: downstream launch waits for Crabbox cleanup"
else
  echo "FAIL: downstream task can launch before Crabbox cleanup" >&2
  exit 1
fi
