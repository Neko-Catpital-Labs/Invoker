#!/usr/bin/env bash
# Proof / gate for durable SSH lease capacity authority.
#
# Default: run the authority proof suite.
# Pass --gate to also require the lease-capacity battery.
set -euo pipefail

RUN_GATES=0
for arg in "$@"; do
  case "$arg" in
    --gate) RUN_GATES=1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "repro: SSH lease capacity authority proof"
cd packages/execution-engine
pnpm exec vitest run src/__tests__/ssh-lease-capacity-authority.proof.test.ts

if [[ "$RUN_GATES" == "1" ]]; then
  echo "gate: lease capacity battery"
  bash "$ROOT/scripts/repro/repro-ssh-lease-capacity-battery.sh" --gate
fi

echo "PASS: SSH lease capacity authority repro finished"
