#!/usr/bin/env bash
set -euo pipefail

# Regression guard: the home-bottom queue chips now derive active-slot counts
# from the live task/workflow stream instead of the 5s queue poll. This script
# covers the four stale windows we reproduced before the fix:
#   1. live workflow/task state arriving before the next 5s queue poll
#   2. a slow in-flight queue poll blocking later ticks
#   3. a queue poll error leaving the old queue snapshot in place
#   4. a hidden window pausing queue polling until visibility returns
#
# It does NOT claim the owner-side 2.5s cache is itself a user-visible stale
# repro for the running/executing chips; that path still needs a separate
# failing case before we should count it.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-queue-status-stale.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] queue chips stay live even when queue status polling lags."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run   src/__tests__/queue-status-stale-repro.test.tsx   >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: the test kept four prior stale-window scenarios live through delayed polls, poll errors, and visibility pauses."
  cat "$LOG_FILE"
  exit 0
else
  status=$?
  echo "[repro] FAIL: the focused live-queue regression did not hold."
  cat "$LOG_FILE"
  exit "$status"
fi
