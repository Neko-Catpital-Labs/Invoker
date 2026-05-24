#!/usr/bin/env bash
# Regression guard: GUI open-terminal must replay early PTY output to renderers
# that subscribe after `openTerminal` resolves.
#
# Background:
#   `EmbeddedTerminalManager` emits terminal output as soon as the backend
#   produces it. The renderer terminal pane only subscribes after React mounts
#   the pane component, which happens AFTER `openTerminal` returns a session
#   descriptor. Any frames the backend emits during that gap were dropped on
#   the floor — most visibly, the first prompt or banner.
#
#   The fix is a bounded per-session replay snapshot, surfaced on the
#   `TerminalSessionDescriptor` (see packages/contracts/src/ipc-channels.ts
#   and packages/app/src/embedded-terminal-manager.ts).
#
# What this script does:
#   Runs the focused permanent regression test in
#     packages/app/src/__tests__/embedded-terminal-manager.test.ts
#   that uses a fake backend to emit `FIRST_FRAME_FROM_PTY\n` synchronously
#   during spawn, then asserts the descriptor carries that frame in
#   `outputSnapshot` so a late consumer can seed its pane from it.
#
# Exit codes:
#   0 — the replay buffer is in place; descriptor includes the first frame.
#   non-zero — regression: early PTY output is dropped (descriptor missing
#              the bounded replay snapshot).
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/packages/app"

exec pnpm exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "replays FIRST_FRAME_FROM_PTY"
