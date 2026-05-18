#!/usr/bin/env bash
# Regression guard for the GUI open-terminal PTY race.
#
# Background:
#   `EmbeddedTerminalManager` (packages/app/src/embedded-terminal-manager.ts)
#   spawns a backend that may emit terminal output synchronously, before
#   `openOrReuse()` returns. The renderer terminal pane subscribes only after
#   the IPC response arrives and the pane mounts. Without a replay snapshot on
#   the returned descriptor, that first frame is lost.
#
# What this script asserts:
#   The focused vitest case below installs a fake backend that emits
#   `FIRST_FRAME_FROM_PTY\n` synchronously during `spawn()` and then attaches a
#   late renderer-style subscriber. The test passes only when the returned
#   `TerminalSessionDescriptor.outputSnapshot` carries that early output.
#
# Exit codes:
#   0 — fix in effect (snapshot carries early synchronous output).
#   non-zero — broken baseline or test failure.
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

pnpm --dir packages/app exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "replays FIRST_FRAME_FROM_PTY emitted synchronously during spawn to a late renderer-style consumer"

pnpm --dir packages/app exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "handles synchronous backend exit during spawn without reading uninitialized state"
