#!/usr/bin/env bash
#
# Repro: warn-level local disk pressure (85-94%) records a warning but does not
# run disk reclaim. Critical pressure (>=95%) still invokes reclaim immediately.
#
# Usage: bash scripts/repro/repro-disk-reclaim-warn-threshold.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPEC="src/__tests__/disk-reclaim-warn-threshold.repro.test.ts"

cd "$REPO_ROOT/packages/execution-engine"

echo "[repro] running disk reclaim warn-threshold proof ..."
if ! pnpm exec vitest run "$SPEC"; then
  echo "[repro] FAIL: disk reclaim warn-threshold repro did not match the expected behavior."
  exit 1
fi

if grep -q "it.fails" "$SPEC"; then
  echo "[repro] reproduced: warn-level disk pressure triggers no reclaim (fix pending in this stack)"
else
  echo "[repro] fixed: warn-level disk pressure now triggers paced reclaim"
fi
