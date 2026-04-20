#!/usr/bin/env bash
# Repro/proof: task failures should remain the primary visible error even when a
# later auto-fix attempt fails, and broad lint / DTS-build-config failures
# should now skip auto-fix entirely instead of timing out and obscuring the real
# root cause.
#
# This script is intentionally deterministic and does not depend on a live
# ~/.invoker SQLite snapshot.
#
# Usage:
#   bash scripts/repro/repro-current-failed-tasks-are-real-task-failures.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "==> orchestrator restores the original task failure on auto-fix revert"
pnpm --filter @invoker/workflow-core exec vitest run \
  src/__tests__/orchestrator.test.ts \
  --testNamePattern "revertConflictResolution preserves the original task failure as primary when auto-fix fails|revertConflictResolution strips older fix wrappers and restores the original failure"

echo
echo "==> broad lint and DTS-build-config failures are classified as fail-fast"
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/auto-fix-session.test.ts \
  --testNamePattern "skips enqueue for broad lint failures|skips dispatch for DTS build failures"

echo
echo "==> auto-fix skip path emits the primary failure instead of attempting repair"
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/workflow-actions.test.ts \
  --testNamePattern "fails fast and skips auto-fix for broad lint failures"

echo
echo "==> headless auto-fix surfaces a skip message with the real primary error"
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/headless-autofix.test.ts \
  --testNamePattern "emits a task-output skip message for fail-fast auto-fix decisions"

echo
echo "repro result:"
echo "- reverting a failed auto-fix restores the original task error instead of prefixing it with a fixer failure"
echo "- broad lint failures are classified as fail-fast, not auto-fixable"
echo "- DTS build/config failures are classified as fail-fast, not auto-fixable"
echo "- UI/headless auto-fix paths emit a skip message that preserves the primary failure context"
echo
echo "This proves the system now treats the task-content failure as primary and avoids SQLite-specific live-state inspection."
