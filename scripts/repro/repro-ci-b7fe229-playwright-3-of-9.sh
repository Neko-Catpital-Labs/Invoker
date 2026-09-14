#!/usr/bin/env bash
# Proof: the CI-equivalent local command for `playwright / 3-of-9` passes once
# .github/workflows/ci.yml runs that job's container with --ipc=host (see the
# prior slice in this stack). This job first failed on default-branch push
# commit b7fe229e0102ba5c25d606b58ee4e566e0500f67, run 32776843830.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pnpm --filter @invoker/ui build
pnpm --filter @invoker/surfaces build
pnpm --filter @invoker/app build

env \
  INVOKER_PLAYWRIGHT_RUN_LABEL='ci-playwright-3-of-9' \
  INVOKER_PLAYWRIGHT_WORKERS=1 \
  INVOKER_PLAYWRIGHT_FILES='e2e/task-death-logs.spec.ts e2e/restart-failed-task.spec.ts e2e/ui-graph-drag-performance.spec.ts e2e/pending-review-gate-target-repo.proof.spec.ts e2e/workflow-status-composition.spec.ts e2e/queue-running-vs-queued.spec.ts e2e/attach-workflow.spec.ts' \
  INVOKER_PLAYWRIGHT_ARGS='--reporter=line' \
  bash scripts/test-suites/optional/40-playwright-app.sh
