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
if ! VITEST_VERSION=$(pnpm --dir packages/app exec vitest --version 2>/dev/null); then
  echo "FAIL: vitest not executable from a workspace package"
  exit 1
fi
echo "    OK: $VITEST_VERSION"

echo ""
echo "==> Worktree provisioning: ALL CHECKS PASSED"
