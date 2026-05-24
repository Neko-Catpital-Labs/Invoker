#!/usr/bin/env bash
#
# Repro for the GUI open-terminal PTY first-frame race.
#
# Before the embedded-terminal replay buffer landed, EmbeddedTerminalManager
# emitted PTY output the instant the backend produced it — which is *before*
# `openOrReuse()` returns and *before* the renderer terminal pane subscribes
# to `invoker:terminal-output`. The first frame was dropped on the floor.
#
# This script runs the focused vitest cases that pin the fix:
#   - the descriptor returned by openOrReuse() contains the bounded
#     outputSnapshot when a fake PTY backend emits FIRST_FRAME_FROM_PTY
#     synchronously during spawn,
#   - a late subscriber can seed from that snapshot, and
#   - synchronous backend exit during spawn does not throw.
#
# Behavior:
#   - Without the replay buffer (broken baseline) the FIRST_FRAME_FROM_PTY
#     assertions fail, vitest exits non-zero, and this script exits non-zero.
#   - With the replay buffer (fixed) all three tests pass, vitest exits 0,
#     and this script exits 0.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/app"
pnpm exec vitest run src/__tests__/embedded-terminal-manager.test.ts \
  -t "PTY first frame|PTY exit during spawn"
