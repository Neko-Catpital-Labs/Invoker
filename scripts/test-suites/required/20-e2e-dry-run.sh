#!/usr/bin/env bash
# Headless Electron case scripts, shard 1 (case-1.*).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [ "${INVOKER_TEST_ALL_PROOF:-0}" = "1" ]; then
  echo "SKIP: covered by dedicated dry-run / case-1 CI shard"
  exit 0
fi

cd "$ROOT"
exec bash "$ROOT/scripts/e2e-dry-run/run-all.sh" 'case-1.*.sh'
