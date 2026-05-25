#!/usr/bin/env bash
# Regression guard: GUI open-terminal must replay the first frame emitted by
# the embedded PTY backend during spawn. Without the bounded outputSnapshot on
# TerminalSessionDescriptor, output emitted before the renderer pane mounts
# (the "first frame") is dropped, leaving the pane blank.
#
# Strategy: run the focused vitest describe block that drives a fake backend
# emitting FIRST_FRAME_FROM_PTY\n synchronously during spawn. The tests assert
# the descriptor's outputSnapshot replays that frame and a late consumer can
# seed from it. On the broken baseline (no replay buffer) these assertions
# fail and the script exits non-zero. After the fix the script exits 0.
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh
#
# Exit codes:
#   0 — replay buffer is in place; first-frame output survives the gap.
#   non-zero — regression: first-frame output is being dropped.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/packages/app"

echo "==> Running embedded-terminal-manager PTY first-frame race regression tests"
pnpm exec vitest run src/__tests__/embedded-terminal-manager.test.ts \
  -t "PTY first-frame race regression"
