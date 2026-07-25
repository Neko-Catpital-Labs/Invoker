#!/usr/bin/env bash
set -euo pipefail

# Repro: a Slack message that presents a drafted plan must always carry an
# Approve button — even when the planner writes a truncated plan-draft file,
# the valid inline plan in the reply must be staged with Approve/Reject.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-slack-approve-button.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] Running Slack approve-button-on-draft regression."

if pnpm -C "$REPO_ROOT" --filter @invoker/surfaces exec vitest run \
  src/__tests__/slack-approve-button-repros.e2e.test.ts \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: drafted plans always arrive with an Approve button and a staged confirmation."
else
  status=$?
  echo "[repro] FAIL: a drafted plan was posted without an Approve button."
  cat "$LOG_FILE"
  exit "$status"
fi
