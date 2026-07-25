#!/usr/bin/env bash
set -euo pipefail

# Repro: "Still thinking…" / "Processing your request…" placeholders must stay
# visible until the real response is posted — never deleted first, leaving the
# thread silent while the planner is still working.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-slack-thinking-deleted.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] Running Slack thinking-placeholder deletion-order regression."

if pnpm -C "$REPO_ROOT" --filter @invoker/surfaces exec vitest run \
  src/__tests__/slack-thinking-placeholder-repros.e2e.test.ts \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: placeholders survive until the real response is posted."
else
  status=$?
  echo "[repro] FAIL: a placeholder was deleted before the response was ready."
  cat "$LOG_FILE"
  exit "$status"
fi
