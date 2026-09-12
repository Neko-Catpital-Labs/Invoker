#!/usr/bin/env bash
# Reproduces the playwright / 1-of-9 readiness regressions with focused tests
# for workflow creation and live review metadata.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pnpm --filter @invoker/ui build
pnpm --filter @invoker/surfaces build
pnpm --filter @invoker/app build

export INVOKER_PLAYWRIGHT_RUN_LABEL='ci-playwright-repro-load-plan-readiness'
export INVOKER_PLAYWRIGHT_WORKERS=1
export INVOKER_PLAYWRIGHT_FILES='e2e/visual-proof.spec.ts'
export INVOKER_PLAYWRIGHT_ARGS='--reporter=line --grep=workflow.delete.propagation|status.bar|review.gate.stack|workflow.inspector|sidebar.keyboard'
exec bash scripts/test-suites/optional/40-playwright-app.sh
