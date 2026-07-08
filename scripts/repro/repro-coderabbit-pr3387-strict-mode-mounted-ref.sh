#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3387 (discussion r3540539960): StrictMode's dev-only
# mount -> cleanup -> remount sequence preserves refs. If the mounted guard is
# only initialized once and cleanup flips it false, the first-page response is
# ignored after the remount and the hook remains loading.
#   - Buggy code never applies the StrictMode response -> vitest fails -> non-zero.
#   - Fixed code resets the guard on setup -> history loads -> zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3387-strict-mode.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #3387: worker history must load after React StrictMode remounts."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/use-worker-action-history.test.tsx \
  -t "loads the first page under React StrictMode remounts" \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: StrictMode remounts leave the mounted guard active for the live request."
  exit 0
else
  status=$?
  echo "[repro] FAIL: StrictMode remount left mountedRef false, so worker history never loaded."
  cat "$LOG_FILE"
  exit "$status"
fi
