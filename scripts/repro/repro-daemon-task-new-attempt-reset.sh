#!/usr/bin/env bash
# Repro: GUI client mode must delegate resume/read state to the daemon owner.
#
# Root cause guarded here:
#   A stale pending launch attempt persisted in SQLite can leave the GUI client
#   showing the old selectedAttemptId after explicit resume if resume/read state
#   is handled by the read-only GUI snapshot instead of the daemon owner.
#
# Fixed behavior:
#   Explicit resume supersedes the stale attempt, clears stale launch runtime
#   fields, and the detached daemon owner exits cleanly before Playwright
#   worker teardown.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

exec scripts/test-suites/required/19-task-new-attempt-reset-repro.sh
