#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "Repro: workflow soft-delete must clear workflow-channel mappings"
if pnpm --filter @invoker/data-store test -- src/__tests__/sync-journal.test.ts -t "removes workflow-channel mappings when soft-deleting a workflow"; then
  echo "PASS: soft-deleted workflows no longer keep workflow-channel mappings"
else
  echo "FAIL: soft-deleted workflows still keep workflow-channel mappings"
  exit 1
fi
