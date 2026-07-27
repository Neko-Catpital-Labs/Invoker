#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TEST_NAME='reports skipped instead of queued when the lifecycle event cannot be published'
if pnpm --filter @invoker/app exec vitest run src/__tests__/review-gate-ci-repair-command.test.ts -t "$TEST_NAME"; then
  echo "[repro] PASS: review-gate CI repair reports skipped when no lifecycle event is published."
  exit 0
fi

echo "[repro] FAIL: review-gate CI repair still reports queued when the lifecycle event is dropped." >&2
exit 1
