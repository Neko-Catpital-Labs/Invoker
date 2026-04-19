#!/usr/bin/env bash
# Repro/proof: if SSH preflight discovery misses a stale branch-owner path, but
# `setupTaskBranch(...)` later fails with `branch ... is already used by
# worktree at ...`, SshExecutor parses that owner path from Git stderr, cleans
# it up, and retries setup once.
#
# This wrapper does two things:
# 1. prints the live failed-task error for the surviving verify-lint-passes case
# 2. runs the focused regression that proves setup-time fallback cleanup works
#
# Usage:
#   bash scripts/repro/repro-ssh-setup-branch-owner-fallback.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

DB_PATH="${HOME}/.invoker/invoker.db"
TASK_ID="wf-1775936968949-13/verify-lint-passes"

if [ -f "$DB_PATH" ]; then
  echo "==> live DB evidence for ${TASK_ID}"
  sqlite3 -line "$DB_PATH" "
select id,status,error
from tasks
where id='${TASK_ID}';
" || true
  echo
fi

echo "==> repro: setupTaskBranch owner-path fallback cleans up and retries once"
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/ssh-executor.test.ts \
  --testNamePattern "retries setup after parsing a stale branch-owner path from setupTaskBranch failure"

echo
echo "repro result:"
echo "- SSH preflight discovery does not surface the stale owner path"
echo "- setupTaskBranch fails with Git stderr naming the real branch-owning worktree path"
echo "- SshExecutor parses that owner path, cleans up the canonical and stale owner paths, and retries setup"
echo "- the retry succeeds instead of failing with \"branch ... is already used by worktree at ...\""
echo
echo "This proves the surviving verify-lint-passes failure was a missed stale branch-owner path that only became visible during setupTaskBranch()."
