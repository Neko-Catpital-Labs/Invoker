#!/usr/bin/env bash
set -euo pipefail

# Repro: the home-bottom queue chips are polled, but workflow/task updates are
# pushed live over a separate channel. This script proves four stale cases:
#   1. running workflow/task state arrives before the next 5s queue poll
#   2. a slow in-flight queue poll blocks later ticks
#   3. a queue poll error leaves old numbers on screen
#   4. a hidden window pauses queue polling until visibility returns
#
# It does NOT claim the owner-side 2.5s cache is itself a user-visible stale
# repro for the running/executing chips; that path needs a separate failing case
# before we should count it.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-queue-status-stale.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] queue chips can lag behind running workflow/task state."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run   src/__tests__/queue-status-stale-repro.test.tsx   >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: the test reproduced four stale queue-chip cases, then showed the chips catch up after a later successful poll / visibility restore."
  cat "$LOG_FILE"
  exit 0
else
  status=$?
  echo "[repro] FAIL: the focused stale-queue repro did not hold."
  cat "$LOG_FILE"
  exit "$status"
fi
