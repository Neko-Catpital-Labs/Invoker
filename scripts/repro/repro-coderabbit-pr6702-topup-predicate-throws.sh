#!/usr/bin/env bash
# Repro for CodeRabbit PR #6702: a throwing ready-task top-up predicate must not
# abort the dispatcher poll. `shouldTopUpReadyLaunches()` runs before
# `dispatchActive()`; if `topUpReadyLaunchesEnabled()` throws and the exception
# escapes, `poll()` exits early and already-enqueued launch rows never dispatch.
#
# The launch-dispatcher regression test exercises poll() with a predicate that
# throws and asserts the enqueued row is still leased/executed. On the buggy
# (pre-fix) code the predicate exception escapes poll(), the test fails, and
# vitest exits non-zero. On the fixed code the exception is caught/logged and
# dispatch still runs, so the test passes and this script exits zero.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() {
  echo "[repro] FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- output -----" >&2
    printf '%s\n' "$2" >&2
  fi
  exit 1
}

set +e
output="$(cd "$ROOT/packages/app" && npx vitest run src/__tests__/launch-dispatcher.test.ts \
  -t "logs and dispatches existing rows when the ready-task top-up predicate throws" 2>&1)"
status=$?
set -e

[ "$status" -eq 0 ] \
  || fail "throwing top-up predicate aborted dispatch (poll did not dispatch enqueued row)" "$output"

printf '%s' "$output" | grep -Eq "1 passed" \
  || fail "expected the throwing-predicate regression test to run and pass" "$output"

echo "[repro] PASS: throwing ready-task top-up predicate is caught; dispatch still runs"
