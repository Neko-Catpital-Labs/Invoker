#!/usr/bin/env bash
# Deterministic regression repro for the GUI open-terminal PTY first-frame race.
#
# Background:
#   `EmbeddedTerminalManager` emits terminal output immediately, but the
#   renderer terminal pane only subscribes after `openTerminal` returns a
#   session descriptor and React mounts the pane. Output emitted during that
#   gap was previously lost.
#
# Behavior:
#   - On the broken baseline (no bounded replay buffer on the session
#     descriptor): the focused vitest cases below fail and this script exits
#     non-zero.
#   - After the fix (descriptor carries `outputSnapshot` seeded from a
#     bounded per-session buffer, and synchronous exit during spawn is safe):
#     this script exits 0.
#
# Non-interactive: no prompts, no TTY required. Safe in CI.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/app"

# Run only the two regression cases that prove the race is closed:
#   1. Late consumer seeds from the descriptor snapshot containing the first
#      PTY frame emitted synchronously during spawn.
#   2. Synchronous backend exit during spawn does not throw and the first
#      frame survives on the descriptor.
#
# `pnpm exec vitest run` (matching scripts/repro-worktree-already-exists.sh)
# is used here because `pnpm test --` does not reliably forward positional
# `-t` filters through the workspace test runner.
pnpm exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "FIRST_FRAME_FROM_PTY"
