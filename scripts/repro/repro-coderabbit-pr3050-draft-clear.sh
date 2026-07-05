#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3050 (discussion r3523490877): after planningChatSubmit succeeds,
# `draftPlanAvailable` / `draftPlanSummary` were never cleared, so the "Submit to
# Invoker" ready bar stayed mounted and could resubmit the same planning session.
#
# The focused regression submits a ready draft, clicks "Submit to Invoker", then
# asserts the ready bar is dismissed.
#   - Buggy code leaves the ready bar visible -> vitest fails -> repro exits non-zero.
#   - Fixed code clears the draft state -> vitest passes -> repro exits zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3050-draft-clear.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #3050: draft state must be cleared after a successful submit."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/coderabbit-pr3050-draft-clear-repro.test.tsx \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: the Submit to Invoker ready bar is dismissed after submit; no resubmit path remains."
  exit 0
else
  status=$?
  echo "[repro] FAIL: the ready bar stayed mounted after submit, so the same session can be resubmitted."
  cat "$LOG_FILE"
  exit "$status"
fi
