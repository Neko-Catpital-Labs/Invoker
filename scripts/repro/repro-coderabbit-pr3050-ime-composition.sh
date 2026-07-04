#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3050 (discussion r3523490884): the composer's Enter-to-submit
# handler did not check IME composition, so the Enter that confirms a CJK/IME
# candidate submitted a half-composed message instead of committing the candidate.
#
# The focused regression presses Enter with nativeEvent.isComposing === true and
# asserts nothing is sent, then confirms a plain Enter still submits.
#   - Buggy code submits the in-progress text -> vitest fails -> repro exits non-zero.
#   - Fixed code skips submission during composition -> vitest passes -> repro exits zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3050-ime-composition.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #3050: Enter-to-submit must ignore in-progress IME composition."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/coderabbit-pr3050-ime-composition-repro.test.tsx \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: Enter during IME composition does not submit; a plain Enter still does."
  exit 0
else
  status=$?
  echo "[repro] FAIL: Enter during IME composition submitted a half-composed message."
  cat "$LOG_FILE"
  exit "$status"
fi
