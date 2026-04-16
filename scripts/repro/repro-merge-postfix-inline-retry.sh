#!/usr/bin/env bash
# Repro script: verify merge-gate auto-fix continues inline when
# post-fix publish fails during the same auto-fix dispatch.
#
# This protects against the "already-in-progress" gap where a failed
# publish-after-fix could leave the task failed without a second AI pass.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT/packages/app"

echo "==> Running targeted workflow-actions test"
OUTPUT="$(pnpm exec vitest run src/__tests__/workflow-actions.test.ts -t 'retries inline when merge post-fix publish fails during auto-fix dispatch' 2>&1)"
echo "$OUTPUT"

if ! printf '%s\n' "$OUTPUT" | rg -q 'attempt 2/3'; then
  echo "[FAIL] Expected inline second auto-fix attempt was not observed."
  exit 1
fi

echo "[PASS] Observed inline second auto-fix attempt after post-fix publish failure."
