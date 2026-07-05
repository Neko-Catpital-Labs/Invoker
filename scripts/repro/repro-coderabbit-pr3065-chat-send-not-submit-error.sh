#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3065 (discussion r3524140233): the generic planningChatSend
# failure path (a plain chat message, not a draft submit) also set
# `planningSubmitError`. When a draft was already ready, that error rendered inside
# the "ready bar" submit-error panel, whose "Retry submit" button calls
# onSubmitDraft — so it resubmits the draft instead of retrying the failed chat.
#
# The focused regression drafts a plan, then sends a chat message that fails, and
# asserts the submit-error panel does NOT appear.
#   - Buggy code opens the submit-error panel -> vitest fails -> repro exits non-zero.
#   - Fixed code keeps the failure in the transcript only -> vitest passes -> repro exits zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3065-chat-send.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #3065: a failed chat message must not open the draft submit-error panel."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/coderabbit-pr3065-chat-send-not-submit-error-repro.test.tsx \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: chat-send failures stay in the transcript; the submit-error panel is reserved for submit failures."
  exit 0
else
  status=$?
  echo "[repro] FAIL: a failed chat message hijacked the submit-error panel (its Retry submit resubmits the draft)."
  cat "$LOG_FILE"
  exit "$status"
fi
