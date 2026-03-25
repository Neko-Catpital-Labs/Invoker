#!/usr/bin/env bash
# Integration test: verify that a fresh git worktree can be provisioned
# and run tests successfully.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

WORKTREE_DIR=$(mktemp -d)
echo "==> Creating worktree at $WORKTREE_DIR"
trap 'echo "==> Cleaning up worktree"; git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"' EXIT

git worktree add "$WORKTREE_DIR" HEAD --quiet
cd "$WORKTREE_DIR"

echo "==> Running pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile

echo "==> Checking vitest is available"
VITEST_BIN=$(node -e "process.stdout.write(require.resolve('vitest/vitest.mjs'))")
if [ -z "$VITEST_BIN" ]; then
  echo "FAIL: vitest not found"
  exit 1
fi
echo "    OK: vitest found at $VITEST_BIN"

echo ""
echo "==> Worktree provisioning: ALL CHECKS PASSED"
