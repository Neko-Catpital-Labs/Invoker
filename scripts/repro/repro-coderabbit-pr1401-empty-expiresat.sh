#!/usr/bin/env bash
# Repro: Crabbox lease metadata must never persist an empty `expiresAt`.
#
# CodeRabbit PR #1401 (packages/execution-engine/src/crabbox-target-resolver.ts):
#   `expiresAt` fell back to '' when status omitted it, but the durable
#   CrabboxRemoteLeaseMetadata contract documents `expiresAt` as an ISO timestamp.
#   Persisting '' risks downstream lease parsing/cleanup failures.
#
# Fixed behavior:
#   The resolver fails loudly with an actionable error naming the target id when
#   status omits (or supplies a whitespace-only) `expiresAt`, instead of writing ''.
#
# Guarded by the vitest case below; this script fails (non-zero) on buggy code.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT/packages/execution-engine"

TEST_FILE="src/__tests__/crabbox-target-resolver.test.ts"
FILTER="throws when status omits expiresAt"

echo "==> Repro: missing/empty expiresAt must throw, not persist an empty string"
if pnpm exec vitest run "$TEST_FILE" -t "$FILTER"; then
  echo "PASS: missing expiresAt is rejected instead of persisted as ''"
else
  echo "FAIL: empty expiresAt persisted into lease metadata (CodeRabbit PR#1401)" >&2
  exit 1
fi
