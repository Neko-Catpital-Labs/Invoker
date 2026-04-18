#!/usr/bin/env bash
# Repro/proof: the historical SSH "worktree already exists" startup failure
# was not caused by recreate-specific behavior.
#
# Proof is two-part:
# 1. Recreate changes the managed SSH branch/worktree identity by bumping the
#    generation salt, so recreate does not intentionally reuse the same path.
# 2. The actual failing class was stale ~/.invoker cleanup on the SSH startup
#    path, which exists independently of recreate.
#
# Usage:
#   bash scripts/repro/repro-ssh-worktree-startup-failure-not-recreate.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "==> proof: recreate changes SSH branch/worktree identity"
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/ssh-executor.test.ts \
  --testNamePattern "changes managed branch and worktree when request salt changes, as recreate does"

echo
echo "==> proof: stale ~/.invoker cleanup was the actual startup bug"
bash scripts/repro/repro-ssh-tilde-worktree-cleanup-miss.sh

echo
echo "proof result:"
echo "- recreate-style generation salt changes the computed SSH branch/worktree"
echo "- the SSH cleanup bug exists on the startup path itself and is independent of recreate"
echo
echo "Conclusion: the historical 'already exists' failure was caused by stale"
echo "~/.invoker cleanup behavior, not by recreate reusing the same SSH worktree."
