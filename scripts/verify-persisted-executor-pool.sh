#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

unset INVOKER_DB_DIR

focused_test_name="persists a concrete built-in pool through save and reload when plan input omits poolId"

run_focused() {
  pnpm --filter @invoker/workflow-core test -- orchestrator -t "$focused_test_name"
}

run_acceptance() {
  pnpm --filter @invoker/workflow-core test -- orchestrator
  pnpm --filter @invoker/data-store test -- sqlite-adapter
  pnpm --filter @invoker/execution-engine test -- task-runner
  pnpm run check:types
}

case "${1:-all}" in
  focused)
    run_focused
    ;;
  all)
    run_focused
    run_acceptance
    ;;
  *)
    printf 'usage: %s [focused|all]\n' "$0" >&2
    exit 2
    ;;
esac
