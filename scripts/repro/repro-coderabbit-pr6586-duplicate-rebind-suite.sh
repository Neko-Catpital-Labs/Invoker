#!/usr/bin/env bash
# Repro for CodeRabbit PR #6586 finding: the surface-worktree-bind-status slice
# re-added an entire `describe('rebindPlanningChatRepo')` suite to
# packages/app/src/__tests__/in-app-planner.test.ts that byte-for-byte
# duplicates the pre-existing suite (identical helpers + identical tests, with
# the invalidate case even dropping two assertions). The duplicate adds no
# coverage and can silently drift.
#
# FAILS (non-zero) while the duplicate block is present; PASSES once the file
# defines the suite exactly once.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="$ROOT_DIR/packages/app/src/__tests__/in-app-planner.test.ts"

if [[ ! -f "$TARGET" ]]; then
  echo "FAIL: target file not found: $TARGET" >&2
  exit 1
fi

suite_count="$(grep -c "describe('rebindPlanningChatRepo'" "$TARGET" || true)"
helper_count="$(grep -c 'function createFakeRebindRepoPool(' "$TARGET" || true)"

echo "describe('rebindPlanningChatRepo') blocks: $suite_count"
echo "createFakeRebindRepoPool declarations:   $helper_count"

if [[ "$suite_count" -ne 1 || "$helper_count" -ne 1 ]]; then
  echo "FAIL: duplicate rebindPlanningChatRepo test suite/helpers detected" >&2
  echo "      expected exactly 1 suite and 1 helper declaration" >&2
  exit 1
fi

echo "PASS: rebindPlanningChatRepo suite and helpers defined exactly once"
