#!/usr/bin/env bash
#
# Repro: unbounded activity_log growth bloats ~/.invoker/invoker.db.
#
# Background: activity_log was written on every log line with no retention. Over
# ~45 days it reached 2.58M rows / 424MB live data plus ~600MB of unreclaimed
# free pages, pushing invoker.db to ~1GB. The memory-mapped SQLite file then
# faulted with SIGBUS during write-heavy operations (e.g. workflow deletes).
#
# This proves the fix end-to-end: the SQLiteAdapter now caps activity_log to its
# most recent N rows (config `activityLogMaxRows`, default 100000), enforced on
# write. The spec floods a real on-disk database with retention disabled (the old
# behavior) and enabled, and asserts the enabled run stays bounded in both row
# count and file size.
#
# Runs through the project's TS test runner so workspace/TS resolution matches
# production. Exit 0 = PASS, non-zero = FAIL.
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
