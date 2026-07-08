#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3387 (discussion r3540539969): switching from one selected
# worker to another while an older-page fetch is in flight must clear the stale
# loadingMore flag. Otherwise the new worker stays permanently blocked from
# loading older history.
#   - Buggy code leaves loadingMore true after the switch -> vitest fails -> non-zero.
#   - Fixed code clears loadingMore with the worker reset -> zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3387-loading-more.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #3387: worker switches must clear stale load-more state."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/use-worker-action-history.test.tsx \
  -t "clears loadingMore when switching workers during an older-page fetch" \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: switching workers clears the in-flight older-page loading state."
  exit 0
else
  status=$?
  echo "[repro] FAIL: switching workers left loadingMore stuck from a stale older-page fetch."
  cat "$LOG_FILE"
  exit "$status"
fi
