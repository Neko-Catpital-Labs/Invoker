#!/usr/bin/env bash
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

run_check() {
  local label="$1"
  shift

  echo "==> $label"
  "$@"
  local exit_code=$?
  echo "<== $label exit_code=$exit_code"
  if [[ "$exit_code" -ne 0 ]]; then
    exit "$exit_code"
  fi
}

run_check "workflow-core plan parser" \
  pnpm --filter @invoker/workflow-core exec vitest run src/__tests__/plan-parser.test.ts -t freshness
run_check "app plan parser" \
  pnpm --filter @invoker/app exec vitest run src/__tests__/plan-parser.test.ts -t freshness
run_check "SQLite task persistence" \
  pnpm --filter @invoker/data-store exec vitest run src/__tests__/sqlite-adapter.test.ts -t freshness
run_check "task runner request preparation" \
  pnpm --filter @invoker/execution-engine exec vitest run src/__tests__/task-runner-prepare.test.ts
run_check "workflow graph exported types" \
  pnpm --filter @invoker/workflow-graph build
run_check "worker contract exported types" \
  pnpm --filter @invoker/contracts build

echo "task-freshness-contract checks passed"
