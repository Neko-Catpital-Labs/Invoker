#!/usr/bin/env bash
# Regression guard: GUI open-terminal PTY output race.
#
# Background:
#   EmbeddedTerminalManager spawns a PTY backend and the renderer terminal pane
#   subscribes to `invoker:terminal-output` only after `openTerminal` returns a
#   session descriptor and React mounts the pane. Output emitted by the PTY
#   during that gap was historically lost (no first frame in the pane).
#
#   The fix adds a bounded per-session output replay buffer in
#   packages/app/src/embedded-terminal-manager.ts that is included on the
#   returned TerminalSessionDescriptor (see packages/contracts/src/ipc-channels.ts).
#
# What this script does:
#   Runs the deterministic regression tests in
#   packages/app/src/__tests__/embedded-terminal-manager.test.ts that use a fake
#   backend emitting "FIRST_FRAME_FROM_PTY\n" synchronously during spawn. The
#   tests assert that:
#     1. The returned descriptor's outputSnapshot includes FIRST_FRAME_FROM_PTY.
#     2. A late consumer (renderer subscribing after openOrReuse() returns) can
#        seed from outputSnapshot, so it observes the first frame.
#     3. A backend that calls emitExit() synchronously during spawn() does not
#        throw and still produces a finalized descriptor with the snapshot.
#
# Exit codes:
#   0 — Replay buffer captures synchronous output and the race regression
#       tests pass (fix in effect).
#   1 — Tests failed (regression present or preconditions broken).
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/packages/app"

echo "==> Running embedded-terminal-manager PTY race regression tests"
pnpm test src/__tests__/embedded-terminal-manager.test.ts -t "FIRST_FRAME_FROM_PTY"
