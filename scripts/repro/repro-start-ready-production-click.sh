#!/usr/bin/env bash
# Repro: clicking "Start ready work" crashed Invoker after deferred startup
# reconcile began calling SQLite adapter methods without `this` binding.
#
# Observed in ~/.invoker/invoker.log:
#   uncaughtException: TypeError: Cannot read properties of undefined (reading 'queryAll')
#     at listWorkflowMutationIntents
#     at reconcileTerminalWorkerActionsOnStartup
#     at Timeout._onTimeout (deferred owner startup maintenance)
#
# Fixed behavior:
#   reconcileTerminalWorkerActionsOnStartup binds store methods before calling
#   them, and deferred startup maintenance is wrapped in try/catch so a reconcile
#   failure cannot take down the GUI owner.
#
# This script:
#   1. Runs the unit repro proving the unbound-method failure mode
#   2. Builds the app
#   3. Launches the real Electron UI against ~/.invoker
#   4. Playwright clicks [data-testid="rail-start-ready"]
#   5. Asserts the process stays alive with no new uncaughtException log lines
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] 1/3 unit repro: unbound listWorkflowMutationIntents crashes without bind"
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/repro-start-ready-deferred-reconcile-bind.test.ts

echo "[repro] 2/3 build app + ui"
pnpm --filter @invoker/ui build >/dev/null
pnpm --filter @invoker/app build >/dev/null

echo "[repro] 3/3 production GUI click: Start ready work"
bash "$ROOT/scripts/kill-all-electron.sh" >/dev/null 2>&1 || true
sleep 1

INVOKER_REPRO_PRODUCTION_DB=1 pnpm --filter @invoker/app exec playwright test \
  e2e/start-ready-production-click.spec.ts

echo "[repro] passed"
