#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] wf-1780385813241-5/capture-after-visual-proof was reaped while executor.start was still launching."
echo "[repro] The attempt heartbeat stayed fresh, but the old 30s launch-dispatch lease expired and was recycled."
echo "[repro] The first test proves the fixed dispatch TTL survives normal executor startup and still reaps after expiry."
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/launch-dispatcher.test.ts \
  -t "uses a fixed dispatch TTL long enough for normal executor startup"

echo "[repro] The second test proves TaskRunner records where launch startup reached."
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-launch-dispatch.test.ts \
  -t "logs executor start begin with launch-dispatch context while executor.start is pending"

echo "[repro] passed"
