#!/usr/bin/env bash
# Regression guard: GUI embedded terminal must replay the PTY's first frame
# to a late-subscribing renderer.
#
# Background: EmbeddedTerminalManager emits terminal output immediately, but
# the renderer terminal pane only subscribes to invoker:terminal-output after
# openTerminal returns a session descriptor and React mounts the pane. The
# first frame the PTY emits during spawn() therefore arrives before any
# renderer listener exists. The fix is a bounded per-session output replay
# buffer, surfaced on TerminalSessionDescriptor.outputSnapshot, that the
# renderer seeds its pane from before attaching its live listener.
#
# This script targets the focused regression tests in
# packages/app/src/__tests__/embedded-terminal-manager.test.ts under the
# describe block "GUI open-terminal PTY race regression". Those tests use a
# fake backend that emits the marker `FIRST_FRAME_FROM_PTY\n` synchronously
# inside spawn(), and assert the returned descriptor (and mgr.list() /
# mgr.get()) carry that frame. Without the replay buffer, the descriptor has
# no snapshot and the assertions fail.
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh
#
# Exit codes:
#   0 — replay buffer in effect; the descriptor carries FIRST_FRAME_FROM_PTY.
#   non-zero — baseline regression (no snapshot, late subscriber loses output)
#              or the test environment failed to run.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/app"

# Use the workspace `pnpm test` script (vitest run) so the binary is resolved
# the same way CI does. The trailing positional and `-t` flag scope vitest to
# the focused regression describe block. pnpm 10 forwards them as-is without a
# `--` separator (the separator is swallowed by pnpm in this version).
exec pnpm test \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "GUI open-terminal PTY race regression"
