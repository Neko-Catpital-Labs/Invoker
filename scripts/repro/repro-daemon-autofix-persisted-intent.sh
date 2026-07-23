#!/usr/bin/env bash
# Repro: delegated no-track runs must not activate removed in-app auto-fix.
#
# Regression guarded here:
#   In daemon/owner mode, a delegated no-track run must not enqueue an
#   `invoker:fix-with-agent` workflow mutation when a task fails.
#
# Expected behavior:
#   The failing task records task.failed without a worker-autofix submission or
#   persisted invoker:fix-with-agent intent from the removed in-app path.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pnpm --filter @invoker/app build
exec scripts/e2e-dry-run/cases/case-2.17-autofix-persists-fix-intent.sh
