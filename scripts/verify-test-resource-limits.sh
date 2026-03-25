#!/usr/bin/env bash
# Smoke: package tests under default (capped), high-resource, and MAX_WORKERS=1 (all exit 0).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT/packages/core"

echo "==> packages/core pnpm test (default: 50% workers via electron-vitest)"
pnpm test

echo "==> packages/core INVOKER_VITEST_HIGH_RESOURCE=1 pnpm test"
INVOKER_VITEST_HIGH_RESOURCE=1 pnpm test

echo "==> packages/core INVOKER_VITEST_MAX_WORKERS=1 pnpm test"
INVOKER_VITEST_MAX_WORKERS=1 pnpm test

echo "verify-test-resource-limits: ok"
