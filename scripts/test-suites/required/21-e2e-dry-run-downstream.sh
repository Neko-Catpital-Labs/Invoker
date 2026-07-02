#!/usr/bin/env bash
# Headless Electron case scripts for downstream shard 2a.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"


exec bash "$ROOT/scripts/e2e-dry-run/run-all.sh" \
  'case-2.1-sequential-success.sh' \
  'case-2.10-cancel-downstream.sh' \
  'case-2.12-manual-approve-downstream.sh' \
  'case-2.14-standalone-timeout-deadlock-guard.sh' \
  'case-2.17-autofix-persists-fix-intent.sh' \
  'case-2.2-sequential-upstream-fail.sh' \
  'case-2.4-fan-in-success.sh' \
  'case-2.7-fan-in-fix.sh' \
  'case-2.9-diamond-fail.sh'
