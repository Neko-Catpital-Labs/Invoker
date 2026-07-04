#!/usr/bin/env bash
# Repro: Crabbox status SSH fields that are whitespace-only must be rejected.
#
# CodeRabbit PR #1401 (packages/execution-engine/src/crabbox-target-resolver.ts):
#   `asNonEmptyString` accepted any string with length > 0, so status values like
#   "   " (sshHost/sshUser/sshKey) passed the required-field check and produced an
#   unusable SSH target that only failed later at connect time.
#
# Fixed behavior:
#   `asNonEmptyString` trims first, so whitespace-only values are treated as
#   missing and `resolve()` throws an actionable error naming the target id.
#
# Guarded by the vitest case below; this script fails (non-zero) on buggy code.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT/packages/execution-engine"

TEST_FILE="src/__tests__/crabbox-target-resolver.test.ts"
FILTER="treats whitespace-only sshHost"

echo "==> Repro: whitespace-only sshHost/sshUser/sshKey must be treated as missing"
if pnpm exec vitest run "$TEST_FILE" -t "$FILTER"; then
  echo "PASS: whitespace-only SSH fields are rejected as missing"
else
  echo "FAIL: whitespace-only SSH fields accepted as valid (CodeRabbit PR#1401)" >&2
  exit 1
fi
