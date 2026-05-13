#!/usr/bin/env bash
# Required regression: every node branch carries direct dependency changes, and
# merge/review gates merge only their direct dependency branch.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

pnpm --filter @invoker/execution-engine exec vitest run src/__tests__/branch-chain.test.ts -t 'review gate direct dependency branch'
