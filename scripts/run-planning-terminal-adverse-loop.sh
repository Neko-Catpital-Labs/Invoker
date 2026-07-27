#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

LOOPS="${INVOKER_PLANNING_TERMINAL_ADVERSE_LOOPS:-1}"

if ! [[ "$LOOPS" =~ ^[0-9]+$ ]] || [[ "$LOOPS" -lt 1 ]]; then
  echo "INVOKER_PLANNING_TERMINAL_ADVERSE_LOOPS must be a positive integer" >&2
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

for ((i = 1; i <= LOOPS; i += 1)); do
  echo "==> planning-terminal adverse loop ${i}/${LOOPS}: renderer repros"
  pnpm --filter @invoker/ui exec vitest run "${UI_TESTS[@]}"

  echo "==> planning-terminal adverse loop ${i}/${LOOPS}: app restore repros"
  pnpm --filter @invoker/app exec vitest run "${APP_TESTS[@]}"
done
