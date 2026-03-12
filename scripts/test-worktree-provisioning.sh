#!/bin/bash
# Integration test: verify that a fresh git worktree can be provisioned
# and run tests successfully (Electron binary present, ABI correct).
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

echo "==> Checking Electron binary exists"
ELECTRON="$WORKTREE_DIR/packages/app/node_modules/.bin/electron"
if [ ! -x "$ELECTRON" ]; then
  echo "FAIL: Electron binary not found at $ELECTRON"
  exit 1
fi
echo "    OK: $ELECTRON"

echo "==> Checking better-sqlite3 loads under Electron's Node"
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" -e \
  "const D = require('better-sqlite3'); const db = new D(':memory:'); db.prepare('SELECT 1').get(); db.close(); console.log('    OK: better-sqlite3 loaded (ABI ' + process.versions.modules + ')');"

echo "==> Running native-module-health test (persistence)"
cd "$WORKTREE_DIR/packages/persistence"
pnpm test -- native-module-health 2>&1

echo ""
echo "==> Worktree provisioning: ALL CHECKS PASSED"
