#!/usr/bin/env bash
# Repro script: SSH managed fan-in must not merge the workflow base marker as a dependency.
#
# This runs the real-git execution-engine regression that sets up:
#   1. a repo with two completed dependency branches,
#   2. a fan-in WorkRequest whose upstreamBranches start with a workflow base
#      branch that is intentionally missing locally,
#   3. worktree-mode setup with an explicit resolved base, matching SSH managed
#      executor startup after base fallback resolution.
#
# Broken behavior:
#   setupTaskBranch tries to merge the synthetic base and fails with
#   MISSING_REF=stack/local-only-base.
#
# Correct behavior:
#   setupTaskBranch drops the workflow base marker and merges only real dependency
#   branches.
#
# Usage:
#   bash scripts/repro/repro-ssh-synthetic-base-missing-ref.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TEST_NAME="drops leading workflow base marker when an explicit resolved base is supplied for worktree setup"

cd "$REPO_ROOT/packages/execution-engine"
pnpm exec vitest run src/__tests__/auto-commit.test.ts -t "$TEST_NAME"
