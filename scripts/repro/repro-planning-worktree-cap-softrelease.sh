#!/usr/bin/env bash
# Repro: Planning worktrees exceed maxWorktrees cap after softRelease
#
# This script runs the planning worktree cap test to demonstrate that:
# 1. softRelease() frees the in-memory slot but leaves worktrees on disk
# 2. Subsequent acquires see <maxWorktrees and create more worktrees
# 3. On-disk planning worktree count exceeds maxWorktrees
#
# Before fix: Tests marked it.fails pass (underlying test fails, showing the bug)
# After fix: Tests pass directly (on-disk count stays <= maxWorktrees)

set -euo pipefail
cd "$(dirname "$0")/../.."

echo "=== Running planning worktree cap softRelease test ==="
pnpm --filter @invoker/execution-engine test -- --run repro-planning-worktree-cap-softrelease

echo ""
echo "=== Test completed ==="
