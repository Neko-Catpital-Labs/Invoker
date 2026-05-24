#!/usr/bin/env bash
# Repro for the embedded GUI terminal "first-frame lost" race.
#
# Bug:
#   `EmbeddedTerminalManager` (packages/app/src/embedded-terminal-manager.ts)
#   spawns a PTY-style backend and emits output immediately. The renderer
#   terminal pane subscribes to `invoker:terminal-output` only AFTER React
#   mounts the pane with the session descriptor returned by `openOrReuse()`.
#   Any output emitted before that subscriber attaches — e.g. the first frame
#   from an interactive agent CLI — is silently dropped on the floor for every
#   late subscriber, including `terminalList()` reloads.
#
# Fix:
#   The manager now buffers a bounded snapshot (most-recent 64 KiB) of every
#   session's output and exposes it on `TerminalSessionDescriptor` as
#   `outputSnapshot`. The placeholder session state is registered BEFORE the
#   backend's spawn() runs, so synchronously emitted output is captured into
#   the buffer and a synchronous backend exit during spawn is resolved against
#   real state instead of an undefined closure.
#
# Deterministic regression contract (this script):
#   The PTY race is converted into unit tests with a fake backend that emits
#   `FIRST_FRAME_FROM_PTY\n` *synchronously during spawn()* — before
#   `openOrReuse()` returns. The tests assert:
#     1. `descriptor.outputSnapshot` contains the first frame.
#     2. A late consumer can seed its terminal from the snapshot and receive
#        subsequent live output via the `output` event without dropping the
#        first frame.
#     3. `list()` includes the same snapshot for a live session.
#     4. Synchronous backend exit during spawn does not throw.
#
# Pass/fail contract:
#   Exit 0  → all four regression tests pass (fix is in place).
#   Exit !0 → at least one regression test failed; the race coverage regressed.
#
# This script is non-interactive and CI-safe: it runs only the focused vitest
# file with a name filter, with no extra setup, no external processes, and no
# touch of git or the filesystem outside the pnpm cache.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_PKG="$ROOT_DIR/packages/app"
TEST_FILE="src/__tests__/embedded-terminal-manager.test.ts"
DESCRIBE_FILTER="EmbeddedTerminalManager — PTY race regression"

if [[ ! -d "$APP_PKG" ]]; then
  echo "[repro] FATAL: packages/app not found at $APP_PKG" >&2
  exit 2
fi
if [[ ! -f "$APP_PKG/$TEST_FILE" ]]; then
  echo "[repro] FATAL: regression test file missing: $APP_PKG/$TEST_FILE" >&2
  exit 2
fi

echo "[repro] Running PTY race regression tests in $APP_PKG"
echo "[repro] Test file : $TEST_FILE"
echo "[repro] Filter    : $DESCRIBE_FILTER"
echo

cd "$APP_PKG"
# Use vitest's -t name filter to scope the run to the PTY race describe block.
# `pnpm exec vitest` is the same binary the package `test` script uses, so this
# matches the repo testing architecture documented in CLAUDE.md without
# requiring a separately-installed vitest.
if pnpm exec vitest run "$TEST_FILE" -t "$DESCRIBE_FILTER"; then
  echo
  echo "[repro] PASS: PTY race regression tests all green — first-frame replay is in place."
  exit 0
fi

echo
echo "[repro] FAIL: PTY race regression tests did not all pass."
echo "[repro]       The embedded terminal first-frame replay regressed."
echo "[repro]       Inspect packages/app/src/embedded-terminal-manager.ts and"
echo "[repro]       packages/contracts/src/ipc-channels.ts:TerminalSessionDescriptor."
exit 1
