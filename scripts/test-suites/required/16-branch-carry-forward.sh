#!/usr/bin/env bash
# Required regression: every node branch carries direct dependency changes, and
# merge/review gates merge only their direct dependency branch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$ROOT/scripts/lib/required-vitest.sh"

run_required_vitest_filter \
  "$ROOT/packages/execution-engine" \
  "src/__tests__/branch-chain.test.ts" \
  "review gate direct dependency branch"
