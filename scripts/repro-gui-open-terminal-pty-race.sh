#!/usr/bin/env bash
# Regression guard: GUI open-terminal PTY race.
#
# The embedded terminal backend used to drop any PTY output that was emitted
# synchronously inside spawn(), because openOrReuse() returned a descriptor
# without the early bytes and the renderer terminal pane only subscribed to
# `invoker:terminal-output` after that descriptor landed. The fix added a
# bounded per-session replay buffer to `EmbeddedTerminalManager` and a
# `outputSnapshot` field on `TerminalSessionDescriptor`.
#
# This script runs the focused vitest cases in
# `packages/app/src/__tests__/embedded-terminal-manager.test.ts` that pin the
# FIRST_FRAME_FROM_PTY marker. On the pre-fix codebase those tests fail
# (snapshot is empty) and this script exits non-zero. After the fix the same
# tests pass and the script exits 0.
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh
#
# Exit codes:
#   0 — focused regression tests passed (fix in effect).
#   non-zero — at least one regression test failed (race not fixed).

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/app"

# `-t` filters by test-name pattern; matches the `describe(...)` block we
# added for the regression cases. Vitest exits non-zero if any matched test
# fails, which is exactly the broken-baseline signal we want.
pnpm exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "GUI open-terminal PTY race regression"
