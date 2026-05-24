#!/usr/bin/env bash
# Regression guard: GUI open-terminal PTY first-frame race.
#
# Goal:
#   `EmbeddedTerminalManager` emits terminal output as soon as the backend
#   produces it, but the renderer terminal pane only subscribes to
#   `invoker:terminal-output` after `openTerminal` returns. Output emitted
#   during that gap used to be dropped. The fix records output into a bounded
#   per-session replay buffer and exposes it as
#   `TerminalSessionDescriptor.outputSnapshot`, so late renderer panes and
#   `terminalList()` reloads can seed their xterm buffer from the descriptor.
#
# Verification strategy:
#   Run the focused vitest cases tagged with the `FIRST_FRAME_FROM_PTY` marker
#   in `packages/app/src/__tests__/embedded-terminal-manager.test.ts`. The
#   tests use a fake backend that emits `FIRST_FRAME_FROM_PTY\n` synchronously
#   during spawn (and, in one case, a synchronous backend exit too). They
#   assert that:
#     1. The returned `TerminalSessionDescriptor.outputSnapshot` contains the
#        first frame.
#     2. A late consumer (`terminalList()` / `get()`) sees the same snapshot.
#     3. Synchronous backend exit during spawn does not throw and still
#        preserves the first frame in the descriptor.
#
# Exit codes:
#   0       — fix in effect (focused tests pass).
#   non-0   — regression (snapshot missing, late consumer empty, or sync exit
#             throws).
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh
#
# This script is non-interactive and has no side effects outside the package
# test sandbox.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/app"

echo "==> Running PTY first-frame race regression tests"
pnpm exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "FIRST_FRAME_FROM_PTY"

echo ""
echo "PASS: PTY first-frame replay regression tests passed"
