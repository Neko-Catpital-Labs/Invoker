#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPEC="src/__tests__/disk-reclaim-event-loop-block.repro.test.ts"

cd "$REPO_ROOT/packages/execution-engine"

if ! pnpm exec vitest run "$SPEC"; then
  echo "[repro] FAIL: local disk sweep event-loop blocking repro failed to run"
  exit 1
fi

if grep -q "it.fails" "$SPEC"; then
  echo "[repro] reproduced: local disk sweep blocks the owner event loop (fix pending in this stack)"
else
  echo "[repro] fixed: local disk sweep no longer blocks the owner event loop"
fi
