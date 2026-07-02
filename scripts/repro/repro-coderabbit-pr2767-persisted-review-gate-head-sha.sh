#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_NAME='uses persisted review-gate lineage when the orchestrator cache is behind'

if pnpm --filter @invoker/app exec vitest run src/__tests__/workflow-actions.test.ts -t "$TEST_NAME"; then
  echo "PASS: fixWithAgentAction accepts persisted review-gate headSha when orchestrator cache is behind"
  exit 0
fi

echo "FAIL: fixWithAgentAction rejected the fresh persisted review-gate headSha as stale" >&2
exit 1
