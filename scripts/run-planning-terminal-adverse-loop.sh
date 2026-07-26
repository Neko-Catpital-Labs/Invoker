#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ITERATIONS="${PLANNING_TERMINAL_ADVERSE_LOOP_ITERATIONS:-${1:-1}}"
if ! [[ "$ITERATIONS" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: PLANNING_TERMINAL_ADVERSE_LOOP_ITERATIONS=<positive integer> $0" >&2
  echo "   or: $0 <positive integer>" >&2
  exit 2
fi

UI_TESTS=(
  src/__tests__/planning-terminal-startup-hydrate-race-repro.test.tsx
  src/__tests__/planning-terminal-session-id-persist-repro.test.tsx
  src/__tests__/planning-terminal-preset-switch-repro.test.tsx
)

APP_TESTS=(
  src/__tests__/planning-terminal-restore-invariants.repro.test.ts
)

for iteration in $(seq 1 "$ITERATIONS"); do
  echo "==> planning-terminal adverse loop ${iteration}/${ITERATIONS}: renderer repros"
  pnpm --filter @invoker/ui exec vitest run "${UI_TESTS[@]}"

  echo "==> planning-terminal adverse loop ${iteration}/${ITERATIONS}: app restore repros"
  pnpm --filter @invoker/app exec vitest run "${APP_TESTS[@]}"
done

