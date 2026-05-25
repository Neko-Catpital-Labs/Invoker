#!/usr/bin/env bash
# Regression guard for the embedded-terminal PTY first-frame race.
#
# Symptom (broken baseline): `EmbeddedTerminalManager.openOrReuse()` returns a
# `TerminalSessionDescriptor` to the renderer, and the renderer's terminal pane
# subscribes to `invoker:terminal-output` only after React mounts. Output
# emitted synchronously by the backend during `spawn()` is therefore lost —
# the first frame ("FIRST_FRAME_FROM_PTY\n" in this repro) never reaches xterm.
#
# Fix (asserted by this script): the manager records output into a bounded
# per-session replay buffer **before** the live event is emitted, and exposes
# the buffer as `outputSnapshot` on the returned descriptor. A late consumer
# seeds xterm from the snapshot, so the first frame is preserved.
#
# How this script asserts the fix:
#   Runs the vitest test in
#   `packages/app/src/__tests__/embedded-terminal-manager.test.ts` whose name
#   matches `FIRST_FRAME_FROM_PTY`. The test uses a fake backend that emits
#   `FIRST_FRAME_FROM_PTY\n` synchronously during spawn and asserts the
#   returned descriptor's `outputSnapshot` contains it. On the broken baseline
#   `outputSnapshot` would be undefined and the test would fail with a
#   non-zero exit code; with the fix the test passes and this script exits 0.
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh
#
# Exit codes:
#   0 — replay buffer surfaces the first PTY frame on the descriptor (fix in
#       effect).
#   1 — the regression test failed (broken baseline) or a precondition is
#       missing.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR/packages/app"

echo "==> Running embedded-terminal PTY race regression test"
echo "    (vitest filter: 'FIRST_FRAME_FROM_PTY')"
pnpm exec vitest run \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "FIRST_FRAME_FROM_PTY"

echo ""
echo "PASS: openOrReuse() descriptor replays FIRST_FRAME_FROM_PTY emitted during spawn"
