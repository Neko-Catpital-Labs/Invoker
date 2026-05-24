#!/usr/bin/env bash
# Repro: GUI open-terminal PTY race — early PTY output emitted synchronously
# during spawn must be retained on the returned TerminalSessionDescriptor so a
# renderer terminal pane that subscribes after openTerminal() resolves can
# replay it.
#
# Before the fix in packages/app/src/embedded-terminal-manager.ts, the
# `FIRST_FRAME_FROM_PTY\n` byte sequence was dropped on the floor — the bytes
# were emitted as a `terminal-output` event before any renderer listener was
# attached, and there was no replay buffer on the descriptor. The fix adds a
# bounded per-session replay buffer and exposes it as `outputSnapshot` on the
# descriptor returned by `openOrReuse()`, `list()`, and `get()`.
#
# This script runs a focused, deterministic vitest target that:
#   - emits FIRST_FRAME_FROM_PTY synchronously during the fake backend spawn,
#   - asserts the returned descriptor (and a late `list()` / `get()` fetch)
#     contains that sequence in `outputSnapshot`,
#   - asserts a synchronous backend exit during spawn does not throw.
#
# Exit code: non-zero on the broken baseline (snapshot missing or throw on
# synchronous exit); 0 once the replay buffer fix is in place.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR/packages/app"
pnpm test src/__tests__/embedded-terminal-manager.test.ts -t "PTY race regression"
