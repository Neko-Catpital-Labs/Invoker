#!/usr/bin/env bash
# N=13 independent roots must refill all scheduler slots after recreate churn.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "repro: fill all 13 slots after recreate churn"
cd packages/app
pnpm exec vitest run src/__tests__/runner-capacity-fill-guarantee.test.ts
echo "PASS: expectedCap=13 stays filled after recreate + lease sweep"
