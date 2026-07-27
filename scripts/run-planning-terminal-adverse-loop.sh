#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

iterations="${PLANNING_TERMINAL_ADVERSE_LOOP_ITERATIONS:-1}"

for ((iteration = 1; iteration <= iterations; iteration += 1)); do
  echo "[planning-terminal-adverse-loop] iteration ${iteration}/${iterations}: ui repros"
  pnpm --filter @invoker/ui exec vitest run \
    src/__tests__/planning-terminal-startup-hydrate-race-repro.test.tsx \
    src/__tests__/planning-terminal-session-id-persist-repro.test.tsx \
    src/__tests__/planning-terminal-preset-switch-repro.test.tsx

  echo "[planning-terminal-adverse-loop] iteration ${iteration}/${iterations}: app repros"
  pnpm --filter @invoker/app exec vitest run \
    src/__tests__/planning-terminal-restore-invariants.repro.test.ts
done
