#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3065 (discussion r3524140230): the submit error lived on the App
# component rather than the planning session, so a submit failure in one chat
# leaked into whatever chat was active afterwards.
#
# The focused regression drafts a plan in two chats, fails the submit in chat #1,
# then switches to chat #2 (its own ready draft, never failed a submit) and asserts
# no submit-error panel shows in chat #2.
#   - Buggy (App-level) code leaks the panel into chat #2 -> vitest fails -> repro exits non-zero.
#   - Fixed (per-session) code keeps the error on chat #1 -> vitest passes -> repro exits zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3065-session-scope.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #3065: a submit error must stay scoped to the chat where it happened."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/coderabbit-pr3065-submit-error-session-scope-repro.test.tsx \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: switching chats does not carry another chat's submit error."
  exit 0
else
  status=$?
  echo "[repro] FAIL: a submit error leaked into a different planning chat after switching."
  cat "$LOG_FILE"
  exit "$status"
fi
