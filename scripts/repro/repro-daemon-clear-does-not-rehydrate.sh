#!/usr/bin/env bash
# Repro: GUI clear in daemon-owner mode must purge durable workflow state.
#
# Root cause guarded here:
#   `invoker:clear` used to reset only the in-memory DAG. With GUI daemon-owner
#   reads, the next snapshot could rehydrate tasks from SQLite, so the UI still
#   saw old tasks after clear.
#
# Fixed behavior:
#   `window.invoker.clear()` leaves the task list empty in the renderer.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

pnpm --filter @invoker/ui build
pnpm --filter @invoker/app build

if command -v xvfb-run >/dev/null 2>&1; then
  exec pnpm --filter @invoker/app exec xvfb-run --auto-servernum playwright test \
    e2e/workflow-lifecycle.spec.ts \
    -g 'clear resets task state via IPC'
fi

exec pnpm --filter @invoker/app exec playwright test \
  e2e/workflow-lifecycle.spec.ts \
  -g 'clear resets task state via IPC'
