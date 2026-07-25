#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-slack-plan-intent-confirm.XXXXXX")"

echo "[repro] Slack plan-intent confirmation"
echo "[repro] /plan theme request -> Plan for execution -> drafted plan -> Approve"

if pnpm -C "$REPO_ROOT" --filter @invoker/surfaces test -- \
  src/__tests__/slack-plan-intent-confirm-repros.e2e.test.ts \
  >"$LOG_FILE" 2>&1; then
  cat "$LOG_FILE"
  echo "[repro] PASS: intent confirmation gates drafting; existing Approve remains the execution gate."
  echo "[repro] log: $LOG_FILE"
else
  status=$?
  cat "$LOG_FILE"
  echo "[repro] FAIL: plan-intent confirmation regression."
  echo "[repro] log: $LOG_FILE"
  exit "$status"
fi
