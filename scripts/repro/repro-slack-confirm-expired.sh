#!/usr/bin/env bash
set -euo pipefail

# Repro: clicking Approve on a drafted plan must never report "This
# confirmation has expired." — each plan stays tied to the message that
# presented it and is submittable any time, across sibling drafts, restarts,
# elapsed time, and failed dispatches.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-slack-confirm-expired.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] Running Slack non-expiring plan confirmation regression."

if pnpm -C "$REPO_ROOT" --filter @invoker/surfaces exec vitest run \
  src/__tests__/slack-confirm-expiry-repros.e2e.test.ts \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: plan confirmations stay message-tied and submittable at any time."
else
  status=$?
  echo "[repro] FAIL: a plan confirmation expired or submitted the wrong draft."
  cat "$LOG_FILE"
  exit "$status"
fi
