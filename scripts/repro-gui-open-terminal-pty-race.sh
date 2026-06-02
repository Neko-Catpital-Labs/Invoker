#!/usr/bin/env bash
#
# Repro: embedded GUI terminal PTY first-frame output race.
#
# The embedded terminal backend can flush its first frame synchronously during
# spawn — before `openOrReuse()` returns and before the renderer terminal pane
# subscribes to `invoker:terminal-output`. Without a replay snapshot on the
# session descriptor, that first frame is lost and a late consumer can never
# recover it.
#
# This script runs the focused regression tests that assert the descriptor
# replays the first frame and that a late consumer can seed from it.
#   - On the broken baseline (no `outputSnapshot`), the tests fail → exit non-zero.
#   - After the replay-buffer fix, the tests pass → exit 0.
#
# Non-interactive; safe to run in CI.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/app"
pnpm exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "PTY first-frame race regression"
