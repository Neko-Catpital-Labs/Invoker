#!/usr/bin/env bash
# Repro/proof: merge-gate feature branch pushes can lose a GitHub ref-update race
# with `cannot lock ref ... is at X but expected Y`, even when the remote already
# has equivalent content.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${HOME}/.invoker/invoker.db"

if [ -f "$DB_PATH" ]; then
  echo "==> live DB evidence for current merge push-race failures"
  sqlite3 -line "$DB_PATH" "
select id,error
from tasks
where id in ('__merge__wf-1775983082635-3','__merge__wf-1775932917566-8');
" || true
  echo
fi

echo "==> repro: merge feature branch push race"
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/git-branch-push-recovery.test.ts \
  src/__tests__/github-merge-gate-provider.test.ts \
  --testNamePattern "pushBranchWithRecovery|cannot-lock-ref race"

echo
echo "repro result:"
echo "- a merge feature-branch push can fail with 'cannot lock ref ... expected ...'"
echo "- the helper now retries that race"
echo "- if the remote branch already has equivalent content, the push is treated as success"
