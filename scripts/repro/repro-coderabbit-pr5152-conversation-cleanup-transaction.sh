#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "Repro: conversation cleanup must roll back if a linked delete fails"
if pnpm --filter @invoker/data-store exec vitest run src/__tests__/sqlite-adapter.test.ts -t "rolls back linked Slack cleanup"; then
  echo "PASS: conversation cleanup deletes are atomic"
else
  echo "FAIL: conversation cleanup left partial Slack state behind"
  exit 1
fi
