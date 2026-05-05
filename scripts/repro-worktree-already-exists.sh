#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/execution-engine"
pnpm exec vitest run src/__tests__/repo-pool.test.ts -t "acquireWorktree: retries once when git reports target worktree path already exists"
