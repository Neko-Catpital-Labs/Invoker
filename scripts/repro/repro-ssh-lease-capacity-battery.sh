#!/usr/bin/env bash
# Required gate: durable SSH lease capacity under orphan/churn/parity scenarios.
#
# Usage:
#   bash scripts/repro/repro-ssh-lease-capacity-battery.sh
#   bash scripts/repro/repro-ssh-lease-capacity-battery.sh --gate
set -euo pipefail

for arg in "$@"; do
  case "$arg" in
    --gate) ;; # accepted; battery is always the gate suite
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "gate: SSH lease capacity battery"
cd packages/execution-engine
pnpm exec vitest run src/__tests__/ssh-lease-capacity-battery.test.ts
echo "PASS: SSH lease capacity battery"
