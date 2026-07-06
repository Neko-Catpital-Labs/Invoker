#!/usr/bin/env bash
# Repro: delegated no-track runs must persist auto-fix mutation intent.
#
# Root cause guarded here:
#   In daemon/owner mode, a delegated no-track run could fail a task without the
#   standalone owner enqueueing the persisted `invoker:fix-with-agent` workflow
#   mutation intent. The failure event existed, but the auto-fix intent was not
#   durable.
#
# Fixed behavior:
#   The failing task records task.failed, debug.auto-fix worker-autofix-submitted,
#   and a persisted invoker:fix-with-agent row in workflow_mutation_intents.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pnpm --filter @invoker/app build
exec scripts/e2e-dry-run/cases/case-2.17-autofix-persists-fix-intent.sh
