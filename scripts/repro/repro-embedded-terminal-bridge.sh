#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "[repro] Verifying display bridge terminal specs survive terminal spec caching."

FAILED=0

run_check() {
  local name="$1"
  shift

  echo "[repro] RUN: $name"
  if "$@"; then
    echo "[repro] PASS: $name"
  else
    local status=$?
    echo "[repro] FAIL: $name (exit $status)" >&2
    FAILED=1
  fi
}

run_check "app embedded terminal manager display bridge contract" \
  pnpm --filter @invoker/app test -- src/__tests__/embedded-terminal-manager.test.ts -t "display bridge"

run_check "execution-engine worktree executor display bridge contract" \
  pnpm --filter @invoker/execution-engine test -- src/__tests__/worktree-executor.test.ts -t "display bridge"

exit "$FAILED"
