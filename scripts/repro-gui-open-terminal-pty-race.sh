#!/usr/bin/env bash
set -euo pipefail

# Reproduces the GUI open-terminal "first-frame PTY output lost" race.
#
# Before the fix, EmbeddedTerminalManager emitted terminal output immediately
# and did not retain a snapshot, so any output produced synchronously during
# backend spawn() — before the renderer subscribed to `invoker:terminal-output`
# — was permanently lost. The renderer terminal pane would then show a blank
# scrollback for the missed frame, including the very first PTY frame.
#
# The deterministic regression below uses a fake backend that emits
# `FIRST_FRAME_FROM_PTY\n` synchronously during spawn(), then asserts:
#   1. The descriptor returned by openOrReuse() carries that frame in its
#      bounded `outputSnapshot`.
#   2. list() / get() also carry it, so terminalList()-driven reloads can
#      seed late-mounted panes.
#   3. A synchronous backend exit during spawn() does not throw and still
#      yields a descriptor with the pre-exit snapshot.
#
# Exits 0 on the fixed implementation. On the broken baseline, the assertions
# on `outputSnapshot` fail and vitest exits non-zero, so this script propagates
# the failure.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/app"
pnpm exec vitest run src/__tests__/embedded-terminal-manager.test.ts \
  -t "FIRST_FRAME_FROM_PTY"
