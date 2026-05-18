#!/usr/bin/env bash
# Repro: embedded GUI terminal PTY first-frame race.
#
# Why this race exists:
#   `EmbeddedTerminalManager` emits terminal output the moment the backend
#   produces it, but the renderer terminal pane subscribes to
#   `invoker:terminal-output` only after `openTerminal` returns a session
#   descriptor and React mounts the pane. Output emitted *during* spawn — the
#   very first frame from a fast PTY — used to be lost.
#
# What this script verifies:
#   The focused tests under
#   `packages/app/src/__tests__/embedded-terminal-manager.test.ts -t "PTY
#   first-frame race regression"` exercise a fake PTY backend that emits
#   `FIRST_FRAME_FROM_PTY\n` synchronously during spawn (and, in one variant,
#   exits synchronously as well). They assert:
#     - the returned descriptor's `outputSnapshot` contains the first frame,
#     - `terminalList()` serves the same snapshot for late-mounting panes, and
#     - a synchronous backend exit during spawn() does not throw.
#
# Pass/fail contract:
#   Exits 0 iff the regression tests pass. On the pre-fix baseline (no
#   replay buffer on `TerminalSessionDescriptor`), the first two tests fail
#   because `session.outputSnapshot` is `undefined`, and this script exits
#   non-zero. After the fix is in place the script exits 0.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd .. && pwd)"
cd "$REPO_ROOT/packages/app"

echo "==> Running embedded-terminal PTY first-frame race regression tests"
# Note: no `--` separator — `pnpm test -- <path>` passes the literal `--` to
# vitest, which silently discards the file filter and runs the entire package
# suite. Passing args directly to `pnpm test` forwards them as positional
# vitest arguments so the run is actually focused on this one file.
pnpm test src/__tests__/embedded-terminal-manager.test.ts \
  -t "PTY first-frame race regression"
