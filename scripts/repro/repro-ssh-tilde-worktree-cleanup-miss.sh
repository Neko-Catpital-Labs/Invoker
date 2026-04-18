#!/usr/bin/env bash
# Repro: SSH managed-worktree cleanup correctly normalizes ~/.invoker
# paths before checking and removing stale worktrees.
#
# Usage:
#   bash scripts/repro/repro-ssh-tilde-worktree-cleanup-miss.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "==> repro: SSH tilde cleanup normalization"
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/ssh-git-exec.test.ts \
  --testNamePattern "removes a stale worktree when canonicalRemoteWt starts with quoted tilde"

echo
echo "repro result:"
echo "- a stale worktree exists at \$HOME/.invoker/worktrees/..."
echo "- buildWorktreeCleanupScript() receives remoteClone='~/.invoker/...' and canonicalRemoteWt='~/.invoker/...'"
echo "- the generated cleanup script runs successfully"
echo "- the stale worktree is removed afterward"
echo "- no literal ./~/.invoker/... directory is created"
echo
echo "This proves the SSH cleanup path now normalizes ~/.invoker paths before"
echo "git worktree add runs, preventing the remote 'already exists' startup failure."
