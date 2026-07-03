#!/usr/bin/env bash
# Repro for CodeRabbit PR #2605: headless session must use the
# configured default agent when persisted task agent names are absent.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
TEST_NAME='uses configured default agent when session task has no persisted agent name'

echo "==> Running CodeRabbit PR #2605 repro: session default agent fallback"
if (cd "$REPO_ROOT" && pnpm --filter @invoker/app exec vitest run src/__tests__/headless-query-capture.test.ts -t "$TEST_NAME"); then
  echo "PASS: headless session used the configured default agent."
else
  echo "FAIL: headless session fell back to a hardcoded agent."
  exit 1
fi
