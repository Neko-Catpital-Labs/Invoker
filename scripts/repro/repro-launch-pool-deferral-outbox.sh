#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

pnpm --filter @invoker/app exec vitest run \
  src/__tests__/launch-pool-deferral-outbox-repro.test.ts \
  --reporter=verbose

pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-launch-dispatch.test.ts \
  --reporter=verbose \
  --testNamePattern 'completes the dispatch row when resource-limit defers the launch'
