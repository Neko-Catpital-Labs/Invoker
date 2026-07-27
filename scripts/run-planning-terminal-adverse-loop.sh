#!/usr/bin/env bash
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$ROOT"

LOOPS="${PLANNING_TERMINAL_ADVERSE_LOOP_COUNT:-1}"
if [[ ! "$LOOPS" =~ ^[1-9][0-9]*$ ]]; then
  echo "PLANNING_TERMINAL_ADVERSE_LOOP_COUNT must be a positive integer." >&2
  exit 2
fi

ui_tests=(
  src/__tests__/planning-terminal-startup-hydrate-race-repro.test.tsx
  src/__tests__/planning-terminal-session-id-persist-repro.test.tsx
  src/__tests__/planning-terminal-preset-switch-repro.test.tsx
)

app_tests=(
  src/__tests__/planning-terminal-restore-invariants.repro.test.ts
)

for ((iteration = 1; iteration <= LOOPS; iteration += 1)); do
  echo "[planning-terminal-adverse] iteration ${iteration}/${LOOPS}: ui repros"
  pnpm --filter @invoker/ui exec vitest run "${ui_tests[@]}"

  echo "[planning-terminal-adverse] iteration ${iteration}/${LOOPS}: app repros"
  pnpm --filter @invoker/app exec vitest run "${app_tests[@]}"
done
