#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

LOOP_COUNT="${PLANNING_TERMINAL_ADVERSE_LOOP_COUNT:-1}"

for ((i = 1; i <= LOOP_COUNT; i += 1)); do
  echo "planning-terminal adverse loop ${i}/${LOOP_COUNT}"
  pnpm --filter @invoker/ui exec vitest run \
    src/__tests__/planning-terminal-startup-hydrate-race-repro.test.tsx \
    src/__tests__/planning-terminal-session-id-persist-repro.test.tsx \
    src/__tests__/planning-terminal-preset-switch-repro.test.tsx
  pnpm --filter @invoker/app exec vitest run \
    src/__tests__/planning-terminal-restore-invariants.repro.test.ts
done
