#!/usr/bin/env bash
# Repro for CodeRabbit PR #2605: omitted manual fix agents must use the
# configured/task-runner default agent for both execution and failure labels.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
TEST_NAME='task runner default agent when manual fix omits agentName'

echo "==> Running CodeRabbit PR #2605 repro: default agent manual fix label"
if (cd "$REPO_ROOT" && pnpm --filter @invoker/app exec vitest run src/__tests__/workflow-actions.test.ts -t "$TEST_NAME"); then
  echo "PASS: omitted manual fix agent used the configured default for execution and label."
else
  echo "FAIL: omitted manual fix agent fell back to the wrong execution agent or label."
  exit 1
fi
