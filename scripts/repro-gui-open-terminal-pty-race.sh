#!/usr/bin/env bash
# Regression guard: GUI open-terminal must replay PTY output emitted before
# the renderer terminal pane subscribes.
#
# Background:
#   `EmbeddedTerminalManager` emits terminal output synchronously from the
#   backend's `spawn()` callback, but the renderer pane only attaches its
#   `invoker:terminal-output` listener after `openTerminal` returns a session
#   descriptor and React mounts the pane. The fix attaches a bounded per-
#   session replay buffer that the manager initializes BEFORE invoking the
#   backend, snapshots into the returned descriptor, and exposes via
#   `terminalList()` so any late consumer can re-seed its pane. The fix also
#   defers synchronous backend-exit notifications so the manager does not
#   touch an uninitialized session state during spawn.
#
# What this script does:
#   Runs the focused unit tests in `packages/app` that pin the regression:
#     - "captures output emitted synchronously during backend spawn …"
#     - "list() exposes the same replay snapshot for live sessions"
#     - "handles synchronous backend exit during spawn without throwing …"
#     - "regression: PTY backend that emits FIRST_FRAME_FROM_PTY …"
#     - "regression: synchronous backend exit during spawn does not crash …"
#     - "replay buffer is bounded — output beyond the maximum byte size …"
#   These tests use fake backends that emit output (and optionally exit)
#   synchronously during `spawn()`, which is exactly the production race.
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh
#
# Exit codes:
#   0 — fix is in place; regression tests pass.
#   non-zero — regression is present (or another failure); see vitest output.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/packages/app"

# Match every regression case in `embedded-terminal-manager.test.ts` that pins
# the early-output replay behaviour. The `-t` pattern is a regex passed to
# vitest; covers the "replay buffer" describe block plus the explicit
# "regression: …" cases added alongside this script.
TEST_NAME_PATTERN='replay buffer|regression: PTY backend that emits FIRST_FRAME_FROM_PTY|regression: synchronous backend exit during spawn'

echo "==> Running focused embedded-terminal replay-buffer regression tests"
echo "    file: packages/app/src/__tests__/embedded-terminal-manager.test.ts"
echo "    -t:   ${TEST_NAME_PATTERN}"

pnpm test src/__tests__/embedded-terminal-manager.test.ts -t "${TEST_NAME_PATTERN}"

echo ""
echo "PASS: GUI open-terminal PTY race regression tests succeeded."
