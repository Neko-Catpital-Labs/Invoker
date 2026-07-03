#!/usr/bin/env bash
# Repro for CodeRabbit PR #2605: omitted headless fix/resolve-conflict
# agent arguments must resolve to the configured default agent.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
TEST_NAME='uses configured default agent when'

echo "==> Running CodeRabbit PR #2605 repro: headless CLI default agent fallback"
if (cd "$REPO_ROOT" && pnpm --filter @invoker/app exec vitest run src/__tests__/headless-fix-autofix-context.test.ts -t "$TEST_NAME"); then
  echo "PASS: omitted headless CLI agents used the configured default."
else
  echo "FAIL: omitted headless CLI agents fell back to a hardcoded default."
  exit 1
fi
