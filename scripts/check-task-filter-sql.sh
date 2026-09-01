#!/usr/bin/env bash
set -euo pipefail

# Rerunnable read-path proof for the task-filter SQL adapter surface.
pnpm --filter @invoker/data-store exec vitest run src/__tests__/task-filter-sql.test.ts
