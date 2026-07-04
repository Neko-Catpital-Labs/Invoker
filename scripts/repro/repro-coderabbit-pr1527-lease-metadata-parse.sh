#!/usr/bin/env bash
# CodeRabbit PR #1527 — Harden remote lease metadata parsing.
#
# Finding: SQLiteAdapter.getRemoteLeaseMetadata did `JSON.parse(raw) as
# RemoteLeaseMetadata`, trusting DB content without validation. Malformed JSON
# threw inside the getter, and a drifted shape (e.g. a non-string leaseId/slug)
# was returned as-is and later crashed restore at `.trim()` instead of returning
# a clean refusal path.
#
# Fix: validate the parsed value (object, provider === 'crabbox', non-empty
# string targetId, string-or-undefined leaseId/slug) and return null on any
# malformed / drifted content, catching JSON.parse errors.
#
# This repro drives the guard tests. On buggy code the malformed-JSON case
# throws and the non-string-field cases return a non-null object, so the test
# fails (non-zero); on fixed code both return null and it passes (zero).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

TEST_FILE="src/__tests__/sqlite-adapter.test.ts"
TEST_NAME="getRemoteLeaseMetadata"

echo "==> repro: getRemoteLeaseMetadata must not crash / trust malformed metadata"
echo "    package : @invoker/data-store"
echo "    test    : $TEST_NAME"

set +e
pnpm --filter @invoker/data-store exec vitest run --reporter dot -t "$TEST_NAME" "$TEST_FILE"
STATUS=$?
set -e

if [[ "$STATUS" -ne 0 ]]; then
  echo "FAIL: getRemoteLeaseMetadata throws or trusts malformed/drifted lease metadata (bug present)."
  exit 1
fi

echo "PASS: getRemoteLeaseMetadata returns null for malformed / drifted metadata."
