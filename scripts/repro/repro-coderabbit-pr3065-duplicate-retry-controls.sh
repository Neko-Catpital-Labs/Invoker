#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3065 (discussion r3524140235): when a submit error was present, the
# top action row and the error panel both rendered "Retry submit" and
# "Keep chatting" buttons with identical accessible names and identical handlers.
# Duplicate accessible names confuse assistive tech and make the intent ambiguous.
#
# The focused regression drives the terminal into the submit-error state and asserts
# exactly one "Retry submit" and one "Keep chatting" control exist.
#   - Buggy code renders two of each -> vitest fails -> repro exits non-zero.
#   - Fixed code hides the top-row actions behind the error panel -> vitest passes -> repro exits zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3065-duplicate-controls.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #3065: the submit-error panel must be the single source of Retry submit / Keep chatting."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/coderabbit-pr3065-duplicate-retry-controls-repro.test.tsx \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: exactly one Retry submit / Keep chatting control while the error panel is shown."
  exit 0
else
  status=$?
  echo "[repro] FAIL: duplicate Retry submit / Keep chatting controls with identical accessible names."
  cat "$LOG_FILE"
  exit "$status"
fi
