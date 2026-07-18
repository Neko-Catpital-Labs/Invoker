#!/usr/bin/env bash
set -euo pipefail

# Repro: after a draft-ready planning session is submitted, a new planning turn
# must keep the live planner stream visible while planningChatSend is still
# pending, then remove it when the final assistant reply arrives.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-planning-thinking-after-submit.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] Planning stream must remain visible during a new pending turn after draft submit."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/planning-draft-submit-new-turn-stream-repro.test.tsx \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: live planner output stays visible while the new request is pending and clears after the final reply."
  exit 0
else
  status=$?
  echo "[repro] FAIL: the focused planning stream regression reproduced."
  cat "$LOG_FILE"
  exit "$status"
fi
