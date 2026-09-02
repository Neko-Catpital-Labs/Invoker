#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec pnpm --filter @invoker/data-store exec vitest run \
  src/__tests__/unbounded-workflow-select.repro.test.ts \
  -t 'listWorkflows materializes every row into JS objects'
