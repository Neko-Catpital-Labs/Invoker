#!/usr/bin/env bash
# Repro: a failed auto-fix can free concurrency without launching other ready
# pending work, because the fix-with-agent mutation path does not run the
# global top-up that restart/recreate paths do.
#
# Usage:
#   bash scripts/repro/repro-ready-pending-idle-after-fix-failure.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo
echo "==> repro: failed fix frees a slot but ready pending work stays idle until global top-up runs"
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/bridge-orchestrator-executor.test.ts \
  --testNamePattern "a failed fix path leaves ready pending work idle until executeGlobalTopup runs"
