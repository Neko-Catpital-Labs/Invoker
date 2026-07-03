#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] verifying cleanup uses the launch-time Crabbox stop config"
if pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "uses the launch-time stop config even if remoteTargets changes before cleanup" \
  --reporter=verbose; then
  echo "PASS: cleanup uses the launch-time stop config"
else
  echo "FAIL: cleanup re-read mutable remoteTargets at completion time" >&2
  exit 1
fi
