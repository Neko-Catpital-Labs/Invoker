#!/usr/bin/env bash
#
# Repro: activity_log grew unbounded and bloated ~/.invoker/invoker.db to ~1GB,
# faulting with SIGBUS during write-heavy work. Proves the fix: the on-disk spec
# floods activity_log with retention off (grows) vs on (bounded in rows + size).
#
# Usage: bash scripts/repro/repro-activity-log-bloat.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPEC="src/__tests__/activity-log-bloat.repro.test.ts"

cd "$REPO_ROOT/packages/data-store"

echo "[repro] running on-disk activity_log bloat proof ..."
if pnpm exec vitest run "$SPEC"; then
  echo "[repro] PASS: activity_log retention bounds the database; the ~1GB/SIGBUS bloat cannot recur."
  exit 0
fi

echo "[repro] FAIL: activity_log was not bounded by retention."
exit 1
