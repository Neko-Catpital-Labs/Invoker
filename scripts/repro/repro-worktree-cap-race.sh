#!/usr/bin/env bash
# Repro: Racy planning worktree cap
#
# This script runs the worktree cap race condition test to verify that:
# 1. Concurrent acquireWorktree calls respect the maxWorktrees limit
# 2. At most maxWorktrees worktrees exist simultaneously
#
# Expected result: Test passes, confirming the RepoPool correctly enforces
# the worktree limit via repoChains serialization.

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running worktree cap race condition test ==="
pnpm --filter @invoker/execution-engine test -- --run repro-worktree-cap-race

echo ""
echo "=== Test passed: RepoPool correctly enforces maxWorktrees limit ==="
