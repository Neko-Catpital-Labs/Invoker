#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOOP_COUNT="${INVOKER_PLANNING_TERMINAL_ADVERSE_LOOP_COUNT:-1}"
if ! [[ "$LOOP_COUNT" =~ ^[0-9]+$ ]] || [ "$LOOP_COUNT" -lt 1 ]; then
  echo "ERROR: INVOKER_PLANNING_TERMINAL_ADVERSE_LOOP_COUNT must be a positive integer" >&2
  exit 2
fi

UI_TESTS=(
  "src/__tests__/planning-terminal-startup-hydrate-race-repro.test.tsx"
  "src/__tests__/planning-terminal-session-id-persist-repro.test.tsx"
  "src/__tests__/planning-terminal-preset-switch-repro.test.tsx"
)
APP_TESTS=(
  "src/__tests__/planning-terminal-restore-invariants.repro.test.ts"
)

for ((iteration = 1; iteration <= LOOP_COUNT; iteration += 1)); do
  echo "==> planning-terminal adverse loop ${iteration}/${LOOP_COUNT}: ui repros"
  pnpm --filter @invoker/ui exec vitest run "${UI_TESTS[@]}"

  echo "==> planning-terminal adverse loop ${iteration}/${LOOP_COUNT}: app repros"
  pnpm --filter @invoker/app exec vitest run "${APP_TESTS[@]}"
done
