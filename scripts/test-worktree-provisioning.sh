#!/usr/bin/env bash
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

echo "==> Checking electron-vitest can start"
ELECTRON_RUN_AS_NODE=1 "$ELECTRON" -e \
  "console.log('    OK: Electron Node.js ABI ' + process.versions.modules);"

echo "==> Checking ABI matches Electron (not system Node)"
EXPECTED_ABI=$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON" -e "process.stdout.write(process.versions.modules)")
BINARY_ABI=$(ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$WORKTREE_DIR/scripts/check-native-modules.js" 2>&1 | grep -o 'OK' || true)
if [ -z "$BINARY_ABI" ]; then
  echo "FAIL: check-native-modules.js did not report OK under Electron"
  exit 1
fi
echo "    OK: check-native-modules reports better-sqlite3 OK under Electron ABI $EXPECTED_ABI"

echo ""
echo "==> Worktree provisioning: ALL CHECKS PASSED"
