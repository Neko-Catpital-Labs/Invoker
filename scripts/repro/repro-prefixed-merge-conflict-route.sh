#!/usr/bin/env bash
# Repro script: verify prefixed post-fix merge-conflict strings
# are still routed to resolveConflict.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT/packages/app"

echo "==> Running targeted prefixed merge-conflict route test"
OUTPUT="$(pnpm exec vitest run src/__tests__/workflow-actions.test.ts -t 'uses resolveConflict for prefixed post-fix merge conflict errors' 2>&1)"
echo "$OUTPUT"

if ! printf '%s\n' "$OUTPUT" | rg -q 'route=resolveConflict'; then
  echo "[FAIL] Expected resolveConflict route was not selected."
  exit 1
fi

echo "[PASS] Prefixed merge-conflict errors route to resolveConflict."
