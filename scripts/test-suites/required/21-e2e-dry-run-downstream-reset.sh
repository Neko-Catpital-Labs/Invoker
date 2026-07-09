#!/usr/bin/env bash
# Headless Electron case scripts, shard 2b (balanced case-2 subset).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

is_merge_queue() {
  [[ "${GITHUB_EVENT_NAME:-}" == "pull_request" && "${GITHUB_HEAD_REF:-}" == mergify/merge-queue/* ]]
}

if is_merge_queue; then
  # Disabled 2026-07-03: case-2.15-recreate-preempt-attempt-refresh.sh and
  # case-2.16-retry-vs-recreate-five-second-window.sh are flaky in merge-queue
  # e2e-proof shard 0. Keep the rest of this required shard active.
  exec bash "$ROOT/scripts/e2e-dry-run/run-all.sh" \
    'case-2.11-edit-restart-downstream.sh' \
    'case-2.13-rebase-recreate-coalesced.sh' \
    'case-2.3-parallel-success.sh' \
    'case-2.5-fan-in-partial-fail.sh' \
    'case-2.6-diamond-success.sh' \
    'case-2.8-fix-reject-downstream.sh'
fi

exec bash "$ROOT/scripts/e2e-dry-run/run-all.sh" \
  'case-2.11-edit-restart-downstream.sh' \
  'case-2.13-rebase-recreate-coalesced.sh' \
  'case-2.15-recreate-preempt-attempt-refresh.sh' \
  'case-2.16-retry-vs-recreate-five-second-window.sh' \
  'case-2.3-parallel-success.sh' \
  'case-2.5-fan-in-partial-fail.sh' \
  'case-2.6-diamond-success.sh' \
  'case-2.8-fix-reject-downstream.sh'
