#!/usr/bin/env bash
# Regression guard: GUI open-terminal PTY race.
#
# `EmbeddedTerminalManager` emits PTY output the moment the backend produces
# bytes. The renderer's `TerminalPane` subscribes to `invoker:terminal-output`
# only after `openTerminal()` returns and the pane mounts. Without a
# main-process replay buffer, any bytes emitted in that window (typical for
# fast-starting shells like `zsh` or replays from `claude --resume`) are lost.
#
# The fix is a bounded per-session replay buffer on `EmbeddedTerminalManager`
# whose contents are exposed on `TerminalSessionDescriptor.outputSnapshot`, so
# late subscribers can seed their terminal from the descriptor itself.
#
# This script runs the two focused vitest tests that exercise the race
# deterministically with a fake backend emitting `FIRST_FRAME_FROM_PTY\n`
# synchronously during spawn:
#
#   1. `replays FIRST_FRAME_FROM_PTY emitted synchronously during spawn to a
#      late consumer`  — asserts descriptor.outputSnapshot is populated and a
#      consumer that mounts after `openOrReuse()` can reconstruct the stream
#      end-to-end by concatenating the snapshot with subsequent live events.
#   2. `handles synchronous backend exit during spawn without throwing
#      (FIRST_FRAME_FROM_PTY)`  — asserts the manager finalizes the session
#      cleanly when the backend emits exit during spawn().
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh
#
# Exit codes:
#   0 — replay buffer + synchronous-exit safety are both in effect (fix landed).
#   non-zero — regression: descriptor.outputSnapshot is missing/empty OR the
#              manager throws/hangs on synchronous backend exit.
#
# The tests live in
# `packages/app/src/__tests__/embedded-terminal-manager.test.ts` and are
# permanent regression coverage; this script is a thin pass/fail driver so
# CI dashboards and humans can both flip one switch to reproduce the race.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/app"

# `-t` matches by test name across the file. Both new tests carry the
# `FIRST_FRAME_FROM_PTY` marker in their titles, so this single pattern
# covers both the replay-buffer assertion and the synchronous-exit safety
# assertion.
pnpm exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "FIRST_FRAME_FROM_PTY"
