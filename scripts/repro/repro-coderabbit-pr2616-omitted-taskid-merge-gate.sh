#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] verifying omitted gate-policy taskId only updates the merge gate"
if pnpm --filter @invoker/app exec vitest run \
  --reporter verbose \
  src/__tests__/slack-gate-policy-op.test.ts \
  -t "treats an omitted gate-policy taskId as the merge gate only"; then
  echo "[repro] PASS: omitted taskId did not match task-specific dependencies."
  exit 0
fi

echo "[repro] FAIL: omitted taskId matched task-specific dependencies."
exit 1
