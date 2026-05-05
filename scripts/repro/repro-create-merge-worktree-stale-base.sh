#!/usr/bin/env bash
# Repro script: createMergeWorktree resolves stale local base refs before fresh origin refs.
#
# This runs the real-git execution-engine test that sets up:
#   1. a bare remote,
#   2. a host clone whose local master is stale,
#   3. a direct remote-only push to master,
#   4. TaskRunner.createMergeWorktree('master', ...).
#
# Broken behavior:
#   clone HEAD follows the stale local master from the clone source.
#
# Correct behavior:
#   clone HEAD follows the freshly fetched origin/master.
#
# Usage:
#   bash scripts/repro/repro-create-merge-worktree-stale-base.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_NAME="prefers freshly fetched origin base over stale local base branch"

cd "$REPO_ROOT/packages/execution-engine"
pnpm exec vitest run src/__tests__/create-merge-worktree.test.ts -t "$TEST_NAME"
