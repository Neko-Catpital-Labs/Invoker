#!/usr/bin/env bash
# Repro: GUI open-terminal PTY first-frame race.
#
# Symptom on the broken baseline:
#   EmbeddedTerminalManager emits terminal output immediately, but the
#   renderer terminal pane subscribes only after openTerminal returns a
#   session descriptor and React mounts the pane. Output emitted before
#   the subscriber attaches is lost.
#
# Fix:
#   Bounded per-session output replay buffer in
#   packages/app/src/embedded-terminal-manager.ts, surfaced as
#   TerminalSessionDescriptor.outputSnapshot in packages/contracts.
#
# This script runs the focused regression tests that fail on the broken
# baseline (no replay buffer / no outputSnapshot field) and pass after
# the fix. Deterministic pass/fail expectation: exit 0 after the fix.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/packages/app"

echo "==> Running FIRST_FRAME_FROM_PTY race regression tests"
# Pass vitest args positionally; `pnpm test -- ...` does not forward them on
# this workspace, so the test-name filter would be silently dropped and the
# whole suite would run.
pnpm test \
  src/__tests__/embedded-terminal-manager.test.ts \
  -t "FIRST_FRAME_FROM_PTY race regression"
