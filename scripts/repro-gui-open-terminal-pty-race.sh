#!/usr/bin/env bash
# Regression guard: embedded GUI terminal must replay the first PTY frame
# that arrives during the gap between `openTerminal` invoking the backend
# spawn and the renderer terminal pane subscribing to output events.
#
# Bug being guarded:
#   `EmbeddedTerminalManager` emits backend output immediately. If the
#   renderer pane subscribes only after `openTerminal()` returns (which is
#   the normal React mount order), any output emitted synchronously during
#   spawn — for example the agent's first banner frame — is silently lost.
#   The fix is a bounded per-session replay buffer attached to the returned
#   `TerminalSessionDescriptor` so the renderer can seed its xterm from it.
#
# How this script proves the fix:
#   It runs the focused vitest block
#     "PTY open-terminal race regression (FIRST_FRAME_FROM_PTY)"
#   in packages/app/src/__tests__/embedded-terminal-manager.test.ts. That
#   block uses a fake backend that emits `FIRST_FRAME_FROM_PTY\n` (and an
#   exit) synchronously from inside `spawn()`, before `openOrReuse()`
#   returns. The assertions are:
#     1. The returned descriptor's `outputSnapshot` contains the first frame.
#     2. A late-subscribing consumer can reconstruct the terminal state by
#        seeding from `outputSnapshot` first.
#     3. `list()` returns the same snapshot for live sessions.
#     4. Synchronous backend exit during spawn does not throw and still
#        carries the snapshot.
#
# Broken baseline (no fix) behavior: `outputSnapshot` is `undefined` (or the
# spawn path throws because the session is finalized before it is inserted
# into the live map). Either way vitest reports a failing test and this
# script exits non-zero.
#
# Fixed behavior: all four assertions hold; vitest exits 0; this script
# exits 0.
#
# Usage:
#   bash scripts/repro-gui-open-terminal-pty-race.sh
#
# Exit codes:
#   0 — fix in effect (vitest block passes).
#   1 — regression (vitest block fails) OR vitest infra failure.

set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Path is resolved relative to packages/app because the pnpm filter chdirs
# into that package before executing vitest.
TEST_FILE_REPO="packages/app/src/__tests__/embedded-terminal-manager.test.ts"
TEST_FILE_PKG="src/__tests__/embedded-terminal-manager.test.ts"
TEST_NAME_PATTERN="PTY open-terminal race regression"

if [[ ! -f "$TEST_FILE_REPO" ]]; then
  echo "[repro-pty-race] FATAL: missing $TEST_FILE_REPO" >&2
  exit 1
fi

TMP_LOG="$(mktemp -t repro-pty-race.XXXXXX.log)"
trap 'rm -f "$TMP_LOG"' EXIT

echo "[repro-pty-race] running focused vitest:"
echo "  file    : $TEST_FILE_REPO"
echo "  pattern : $TEST_NAME_PATTERN"

set +e
# --reporter=verbose so per-test names are always in the log; required by the
# "did the focused block actually run" defensive check below.
pnpm --filter @invoker/app exec vitest run "$TEST_FILE_PKG" \
  -t "$TEST_NAME_PATTERN" --reporter=verbose \
  >"$TMP_LOG" 2>&1
VITEST_STATUS=$?
set -e

# Always surface the focused vitest output so failures are easy to triage.
cat "$TMP_LOG"

if [[ "$VITEST_STATUS" -ne 0 ]]; then
  echo
  echo "[repro-pty-race] FAIL: focused PTY race regression vitest block did not pass." >&2
  echo "[repro-pty-race]       Broken baseline = descriptor.outputSnapshot undefined" >&2
  echo "[repro-pty-race]       OR synchronous exit during spawn threw." >&2
  exit 1
fi

# Defensive: confirm the focused block actually ran (catches the case where
# the test file got renamed/moved and vitest reported 0 because nothing matched).
if ! grep -qE 'FIRST_FRAME_FROM_PTY|PTY open-terminal race regression' "$TMP_LOG"; then
  echo "[repro-pty-race] FAIL: vitest exited 0 but the focused block did not run." >&2
  echo "[repro-pty-race]       Check that test name pattern \"$TEST_NAME_PATTERN\"" >&2
  echo "[repro-pty-race]       still matches a describe block in $TEST_FILE_REPO." >&2
  exit 1
fi

echo
echo "[repro-pty-race] PASS: embedded terminal replay buffer is preserving the first PTY frame."
exit 0
