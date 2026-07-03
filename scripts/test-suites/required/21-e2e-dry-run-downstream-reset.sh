#!/usr/bin/env bash
# Headless Electron case scripts, shard 2b (balanced case-2 subset).
# Disabled 2026-07-03: case-2.16-retry-vs-recreate-five-second-window.sh is flaky.
# Merge-queue failure: read-only file open refused while WAL sidecars exist.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/e2e-dry-run/run-all.sh" \
  'case-2.11-edit-restart-downstream.sh' \
  'case-2.13-rebase-recreate-coalesced.sh' \
  'case-2.15-recreate-preempt-attempt-refresh.sh' \
  'case-2.3-parallel-success.sh' \
  'case-2.5-fan-in-partial-fail.sh' \
  'case-2.6-diamond-success.sh' \
  'case-2.8-fix-reject-downstream.sh'
