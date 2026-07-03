#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] verifying manual Crabbox stop text includes configured stopArgs"
if pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "keeps the lease on failure and appends connect/stop commands" \
  --reporter=verbose; then
  echo "PASS: manual stop command includes stopArgs"
else
  echo "FAIL: manual stop command omitted stopArgs" >&2
  exit 1
fi
