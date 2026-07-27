#!/usr/bin/env bash
set -euo pipefail

# Repro: after a draft-ready planning session is submitted, a new planning turn
# must keep the live planner stream visible while planningChatSend is still
# pending, then remove it when the final assistant reply arrives.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-planning-thinking-after-submit.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] Running focused planning stream visibility regression."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/planning-thinking-after-submit-repro.test.tsx \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: live planner output stays visible during the pending new turn and clears after the final reply."
  exit 0
else
  status=$?
  echo "[repro] FAIL: planning stream visibility regression failed."
  cat "$LOG_FILE"
  exit "$status"
fi
