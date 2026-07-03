#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] verifying missing Crabbox stop implementation logs cleanup failure"
if pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "logs cleanup failure instead of success when the resolver cannot stop leases" \
  --reporter=verbose; then
  echo "PASS: missing stop implementation is not logged as successful cleanup"
else
  echo "FAIL: missing stop implementation was treated as successful cleanup" >&2
  exit 1
fi
