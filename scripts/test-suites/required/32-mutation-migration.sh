#!/usr/bin/env bash
# Required proof coverage for moving recreate generation bumps behind workflow-core.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

if [[ "${INVOKER_TEST_ALL_PROOF:-0}" == "1" ]]; then
  echo "SKIP: required-fast runs mutation migration repro separately."
  exit 0
fi

exec bash scripts/repro/prove-mutation-migration.sh
