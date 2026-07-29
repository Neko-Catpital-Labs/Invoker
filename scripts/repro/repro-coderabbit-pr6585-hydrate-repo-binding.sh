#!/usr/bin/env bash
set -euo pipefail

# CodeRabbit PR #6585 (discussion r3677119226): sessionToSummary now emits
# repoUrl / baseBranch / baseCommit, but hydrateRemotePlanningTerminalSession did
# not restore them. A remote summary round trip therefore lost the repository
# binding, which can make later rebind logic misidentify the stored repo and lose
# release metadata.
#
# The focused regression creates a repo-bound planning session, takes its summary,
# hydrates it, and asserts all three binding fields survive the round trip.
#   - Buggy code drops the fields on hydration -> vitest fails -> repro exits non-zero.
#   - Fixed code restores the fields -> vitest passes -> repro exits zero.

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-pr6585-hydrate.XXXXXX.log")"
trap 'rm -f "$LOG_FILE"' EXIT

echo "[repro] PR #6585: hydration must restore repoUrl/baseBranch/baseCommit."

if pnpm -C "$REPO_ROOT" --filter @invoker/app exec vitest run \
  src/__tests__/in-app-planner.test.ts \
  -t "preserves repo binding fields across the summary-to-hydrated-session round trip" \
  >"$LOG_FILE" 2>&1; then
  echo "[repro] PASS: repo binding fields survive the summary-to-hydrated-session round trip."
  exit 0
else
  status=$?
  echo "[repro] FAIL: hydration dropped repo binding fields on the summary round trip."
  cat "$LOG_FILE"
  exit "$status"
fi
