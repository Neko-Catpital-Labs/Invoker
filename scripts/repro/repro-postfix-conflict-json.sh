#!/usr/bin/env bash
# Repro script: verify publish-after-fix emits structured merge_conflict JSON.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT/packages/execution-engine"

echo "==> Running targeted publish-after-fix conflict test"
OUTPUT="$(pnpm exec vitest run src/__tests__/publish-after-fix.test.ts -t 'emits merge_conflict JSON when post-fix consolidation merge conflicts' 2>&1)"
echo "$OUTPUT"

if ! printf '%s\n' "$OUTPUT" | rg -q '"type":"merge_conflict"'; then
  echo "[FAIL] Expected merge_conflict JSON marker was not emitted."
  exit 1
fi

echo "[PASS] publish-after-fix emits structured merge_conflict JSON."
