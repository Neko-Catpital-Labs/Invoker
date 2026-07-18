#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #3050 (discussion r3523490880): the "run" text command called
# handleStart() directly, guarded only by `!hasLoadedPlan`. Unlike the Start
# button (`showStart = hasLoadedPlan && !hasStarted`) it omitted the `hasStarted`
# check and never engaged `plannerBusy`, so typing "run" again after a run had
# already started re-invoked invoker.start().
#
# The focused regression starts a run, then types "run" again and asserts start()
# is not called a second time (and that the guard reports "Run already started.").
#   - Buggy code fires invoker.start() twice -> vitest fails -> repro exits non-zero.
#   - Fixed code rejects the second run -> vitest passes -> repro exits zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr3050-run-guard.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #3050: 'run' text command must honor the hasStarted guard."

if pnpm -C "$REPO_ROOT" --filter @invoker/ui exec vitest run \
  src/__tests__/coderabbit-pr3050-run-guard-repro.test.tsx \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: a second 'run' after start is rejected; invoker.start() is invoked exactly once."
  exit 0
else
  status=$?
  echo "[repro] FAIL: 're-running' after start re-invoked invoker.start(); the busy/hasStarted guard is missing."
  cat "$LOG_FILE"
  exit "$status"
fi
