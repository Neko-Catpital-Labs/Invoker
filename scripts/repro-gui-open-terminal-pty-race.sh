#!/usr/bin/env bash
#
# Repro: GUI open-terminal PTY first-frame race.
#
# The renderer terminal pane subscribes to `invoker:terminal-output` only after
# `openTerminal` returns the session descriptor and React mounts the pane. On
# the broken baseline, PTY output emitted synchronously during spawn was lost,
# because the renderer had not yet attached its listener and the main process
# kept no replay buffer.
#
# After the fix, `EmbeddedTerminalManager` registers the session before invoking
# the backend, captures synchronous backend output into a bounded per-session
# replay buffer, and exposes that snapshot on `TerminalSessionDescriptor` via
# `outputSnapshot`. The renderer (or `terminalList()` reload) can seed from the
# snapshot before listening to live events.
#
# This script targets the regression tests in
# `packages/app/src/__tests__/embedded-terminal-manager.test.ts` that use the
# `FIRST_FRAME_FROM_PTY` marker. They fail deterministically on the broken
# baseline (the descriptor has no `outputSnapshot`, so the asserted string is
# never replayed) and pass after the fix.
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh
#
# Exit codes:
#   0 — replay snapshot regression tests pass (fix in place).
#   non-zero — early PTY output is not replayable from the descriptor.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/app"
exec pnpm exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "FIRST_FRAME_FROM_PTY"
