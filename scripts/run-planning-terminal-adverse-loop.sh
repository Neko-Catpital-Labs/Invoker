#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RUNS="${PLANNING_TERMINAL_ADVERSE_LOOP_RUNS:-${1:-1}}"
if ! [[ "$RUNS" =~ ^[1-9][0-9]*$ ]]; then
  echo "PLANNING_TERMINAL_ADVERSE_LOOP_RUNS or first argument must be a positive integer." >&2
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

for run in $(seq 1 "$RUNS"); do
  printf 'planning-terminal adverse loop %s/%s\n' "$run" "$RUNS"
  pnpm --filter @invoker/ui exec vitest run "${UI_TESTS[@]}"
  pnpm --filter @invoker/app exec vitest run "${APP_TESTS[@]}"
done
