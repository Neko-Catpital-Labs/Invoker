#!/usr/bin/env bash
# Repro / regression guard for the GUI open-terminal PTY output race.
#
# Background:
#   `EmbeddedTerminalManager` (packages/app/src/embedded-terminal-manager.ts)
#   spawns a node-pty child and subscribes via `pty.onData(emitOutput)`. The
#   renderer terminal pane only subscribes to the IPC `terminal-output` stream
#   after `openTerminal` returns a session descriptor and React mounts. Output
#   emitted between PTY spawn and renderer subscription was silently dropped.
#
#   The fix adds a bounded per-session replay buffer that is pre-allocated
#   before the backend spawns, so synchronous output during `backend.spawn()`
#   lands in the buffer and is surfaced as `outputSnapshot` on
#   `TerminalSessionDescriptor`.
#
# What this script does:
#   Runs the focused unit tests in
#   `packages/app/src/__tests__/embedded-terminal-manager.test.ts` that use a
#   fake PtyLike emitting `FIRST_FRAME_FROM_PTY\n` synchronously inside
#   `pty.onData()`. The tests assert:
#     1. The descriptor returned by `openOrReuse()` carries the synchronous
#        first frame in `outputSnapshot`.
#     2. A late consumer (`mgr.get()` / `mgr.list()`) sees the same snapshot.
#     3. Synchronous PTY exit during spawn does not throw and surfaces the
#        correct exit code.
#
# Exit codes:
#   0 — replay buffer is in effect and the race is closed.
#   non-zero — regression: synchronous PTY output is not preserved on the
#              returned descriptor, or synchronous exit during spawn threw.
#
# Non-interactive: takes no input, prints progress to stdout/stderr.
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/packages/app"

echo "==> Running embedded-terminal-manager PTY race regression tests"
echo "    file: packages/app/src/__tests__/embedded-terminal-manager.test.ts"
echo "    filter: PTY race regression (FIRST_FRAME_FROM_PTY) + synchronous exit"
echo

# Forward args directly to `vitest run` via the package's `test` script.
# Note: pnpm consumes `--` here and would not forward subsequent args; pass
# them as positional args instead. vitest's `-t` is a regex match against
# test names, so the OR pattern covers both regression tests in one run.
pnpm run test \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "FIRST_FRAME_FROM_PTY|PTY backend exits synchronously"

echo
echo "PASS: PTY race is closed — synchronous first-frame output is replayed"
echo "      to late consumers via TerminalSessionDescriptor.outputSnapshot."
