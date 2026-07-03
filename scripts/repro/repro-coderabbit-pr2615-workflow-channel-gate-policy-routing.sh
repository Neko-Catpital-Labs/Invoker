#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] CodeRabbit PR #2615: workflow-channel gate-policy commands route to workflow ops"
if pnpm --filter @invoker/surfaces exec vitest run \
  src/__tests__/slack-surface-workflows.test.ts \
  -t "routes workflow-channel gate-policy commands to workflow ops"; then
  echo "[repro] PASS: workflow-channel gate-policy command reached runWorkflowOp"
else
  echo "[repro] FAIL: workflow-channel gate-policy command did not reach runWorkflowOp"
  exit 1
fi
