#!/usr/bin/env bash
# Required regression coverage for explicit resume replacing stale task launch attempts.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

pnpm --filter @invoker/ui build
pnpm --filter @invoker/app build

if command -v xvfb-run >/dev/null 2>&1; then
  exec pnpm --filter @invoker/app exec xvfb-run --auto-servernum playwright test \
    e2e/task-new-attempt-reset.spec.ts
fi

exec pnpm --filter @invoker/app exec playwright test \
  e2e/task-new-attempt-reset.spec.ts
