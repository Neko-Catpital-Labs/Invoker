#!/usr/bin/env bash
# Repro: output tail cache should not return stale chunks after task/workflow deletion.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT/packages/data-store"

echo "==> Running focused sqlite-adapter deletion/cache repro tests"
pnpm test -- src/__tests__/sqlite-adapter.test.ts -t "output spool rows"
