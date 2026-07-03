#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] verifying omitted keepOnFailure keeps failed Crabbox leases"
if pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "defaults omitted keepOnFailure to keeping failed leases for debugging" \
  --reporter=verbose; then
  echo "PASS: omitted keepOnFailure uses the default debug-preserving policy"
else
  echo "FAIL: omitted keepOnFailure was treated as false" >&2
  exit 1
fi
