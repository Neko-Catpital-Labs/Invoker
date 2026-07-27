#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "Repro: task updates must journal non-status mutations and affected workflow rollups"
if ! pnpm --filter @invoker/data-store test -- src/__tests__/sync-journal.test.ts -t "journals non-status task updates"; then
  echo "FAIL: non-status task updates still miss sync journal entries"
  exit 1
fi
if ! pnpm --filter @invoker/data-store test -- src/__tests__/sync-journal.test.ts -t "journals workflow rollup changes when moving a task between workflows"; then
  echo "FAIL: moved tasks still miss affected workflow journal entries"
  exit 1
fi

echo "PASS: task updates journal non-status mutations and affected workflow rollups"
