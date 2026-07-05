#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3065 (discussion r3524140238): the "Copy error" button did
# `void navigator.clipboard?.writeText(...)`. writeText can reject (e.g. denied
# permission); voiding it attaches no rejection handler, so the failure surfaces as
# an unhandled promise rejection. App.tsx's handleCopyWorkflowId already guards with
# `.catch(() => {})`.
#
# The focused regression clicks "Copy error" with a rejecting clipboard and asserts
# no unhandled rejection is emitted.
#   - Buggy code leaves the rejection unhandled -> vitest fails -> repro exits non-zero.
#   - Fixed code catches it -> vitest passes -> repro exits zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3065-clipboard.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #3065: Copy error must handle a rejected clipboard write."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/coderabbit-pr3065-clipboard-rejection-repro.test.tsx \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: a denied clipboard write is caught; no unhandled rejection."
  exit 0
else
  status=$?
  echo "[repro] FAIL: a denied clipboard write surfaced as an unhandled promise rejection."
  cat "$LOG_FILE"
  exit "$status"
fi
