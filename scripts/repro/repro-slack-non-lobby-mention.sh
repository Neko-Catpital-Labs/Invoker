#!/usr/bin/env bash
set -euo pipefail

# Repro: @Invoker hi outside the lobby / mapped workflow channel must NOT
# refuse with "I only plan in the lobby channel…". Mentions in any channel
# where the bot is present route to the same handleMention path.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-slack-non-lobby-mention.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] Running Slack non-lobby mention routing regression."

if ! pnpm -C "$REPO_ROOT" --filter @invoker/surfaces exec vitest run \
  src/__tests__/slack-do1-ux-non-lobby-mention.e2e.test.ts \
  src/__tests__/slack-surface-workflows.test.ts \
  -t 'routes every @mention|routes a mention to planning from any channel|never refuses a mention' \
  >"$LOG_FILE" 2>&1; then
  status=$?
  echo "[repro] FAIL: non-lobby @mention routing regressed."
  cat "$LOG_FILE"
  exit "$status"
fi

if rg -nF 'I only plan in the lobby channel (or DMs)' \
  "$REPO_ROOT/packages/surfaces/src" \
  "$REPO_ROOT/packages/surfaces/dist" 2>/dev/null; then
  echo "[repro] FAIL: stale lobby-channel refusal string is still present in surfaces src/dist."
  exit 1
fi

echo "[repro] PASS: @Invoker hi outside lobby/workflow channels is not refused."
