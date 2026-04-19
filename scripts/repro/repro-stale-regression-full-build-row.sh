#!/usr/bin/env bash
# Proof: wf-1775874004544-6/regression-full-build is an old failed row from the
# pre-fix TS6307 DTS build bug. The old runtime-domain/runtime-adapters/transport
# failure class is fixed now; the current workspace build fails later on a
# different error.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${HOME}/.invoker/invoker.db"
TASK_ID="wf-1775874004544-6/regression-full-build"

if [ ! -f "$DB_PATH" ]; then
  echo "Missing DB at $DB_PATH" >&2
  exit 1
fi

TASK_ROW="$(sqlite3 -line "$DB_PATH" "
select id,status,error
from tasks
where id='${TASK_ID}';
")"
printf '%s\n' "$TASK_ROW"
printf '%s\n' "$TASK_ROW" | rg -q "${TASK_ID}"
printf '%s\n' "$TASK_ROW" | rg -q 'TS6307|error occurred in dts build'

pnpm --filter @invoker/runtime-domain build
pnpm --filter @invoker/runtime-adapters build
pnpm --filter @invoker/transport build

set +e
WORKSPACE_OUTPUT="$(pnpm -r build 2>&1)"
WORKSPACE_EXIT=$?
set -e
printf '%s\n' "$WORKSPACE_OUTPUT" | tail -n 40

if [ "$WORKSPACE_EXIT" -eq 0 ]; then
  exit 0
fi

if printf '%s\n' "$WORKSPACE_OUTPUT" | rg -q 'packages/data-store build:.*TS2367|src/sqlite-adapter.ts\\(1692,10\\): error TS2367'; then
  exit 0
fi

if printf '%s\n' "$WORKSPACE_OUTPUT" | rg -q 'TS6307|error occurred in dts build'; then
  echo "[FAIL] Expected the old TS6307 DTS failure class to be gone from the workspace build." >&2
  exit 1
fi

echo "[FAIL] Expected the workspace build to move past the old TS6307 failure and stop on a different error."
exit 1
