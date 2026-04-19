#!/usr/bin/env bash
# Repro/proof: when an SSH worktree vanishes during execution, the real ENOENT/uv_cwd
# failure should remain primary even if the later record/push step also fails.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${HOME}/.invoker/invoker.db"
TASK_ID="wf-1775936968949-13/verify-check-all"

if [ -f "$DB_PATH" ]; then
  echo "==> live DB evidence for ${TASK_ID}"
  sqlite3 -line "$DB_PATH" "
select id,status,error
from tasks
where id='${TASK_ID}';
" || true
  echo
  echo "==> recent task output for ${TASK_ID}"
  sqlite3 "$DB_PATH" "
select substr(data,1,240)
from task_output
where task_id='${TASK_ID}'
order by id desc
limit 12;
" || true
  echo
fi

echo "==> repro: preserve primary SSH execution failure when finalize also fails"
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/ssh-executor.test.ts \
  --testNamePattern "preserves the primary remote execution failure when record/push also fails later"

echo
echo "repro result:"
echo "- the remote task fails first with ENOENT / uv_cwd"
echo "- record/push fails second because the same worktree path is gone"
echo "- the final task error keeps the first real failure instead of the later push error"
