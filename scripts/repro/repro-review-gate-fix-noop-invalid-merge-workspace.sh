#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_NAME="fixWithAgentAction rejects invalid merge-gate workspaces before fix execution"

echo "[repro] problem: failed external-review merge gates can show 'Fix with Codex' while their saved merge workspace is invalid"
echo "[repro] root cause: fixWithAgentAction rejects invalid merge-gate workspaces before fix execution"
echo "[repro] proof: beginConflictResolution, taskExecutor.resolveConflict, and taskExecutor.fixWithAgent must stay untouched"

if pnpm --filter @invoker/app exec vitest run \
  src/__tests__/workflow-actions.test.ts \
  -t "$TEST_NAME" \
  --reporter=verbose; then
  echo "[repro] PASS: invalid merge-gate workspace is rejected before the fix flow starts"
  exit 0
fi

echo "[repro] FAIL: invalid merge-gate workspace no longer proves the fix flow is skipped"
exit 1
