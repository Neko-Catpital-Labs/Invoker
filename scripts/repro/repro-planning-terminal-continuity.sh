#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

status=0

run_repro() {
  local name="$1"
  shift

  echo "[repro] Running ${name}."
  if "$@"; then
    echo "[repro] PASS ${name}"
  else
    echo "[repro] FAIL ${name}"
    status=1
  fi
}

echo "[repro] Checking planning terminal continuity regressions."

run_repro "planning terminal session id persistence" \
  pnpm --filter @invoker/ui test -- src/__tests__/planning-terminal-session-id-persist-repro.test.tsx

run_repro "planning terminal startup hydrate race" \
  pnpm --filter @invoker/ui test -- src/__tests__/planning-terminal-startup-hydrate-race-repro.test.tsx

exit "$status"
