#!/usr/bin/env bash
# Headless Electron case scripts, shard 1 (case-1.*).
# INV-119 selected the split dry-run shard design; keep this shard bound to
# the experiment's deterministic 9-case threshold.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
export INVOKER_E2E_DRY_RUN_EXPECTED_CASES=9
exec bash "$ROOT/scripts/e2e-dry-run/run-all.sh" 'case-1.*.sh'
