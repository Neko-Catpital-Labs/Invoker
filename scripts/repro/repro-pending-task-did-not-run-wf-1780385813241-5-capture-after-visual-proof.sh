#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] wf-1780385813241-5/capture-after-visual-proof was reaped while executor.start was still launching."
echo "[repro] The attempt heartbeat stayed fresh, but the launch-dispatch lease expired after 30s and was recycled."
echo "[repro] The first test demonstrates the no-renew condition is reaped, then proves renewal prevents reaping."
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/launch-dispatcher.test.ts \
  -t "renewDispatch keeps a slow in-flight launch from being reaped"

echo "[repro] The second test proves TaskRunner renews the dispatch lease during a slow executor.start."
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-launch-dispatch.test.ts \
  -t "renews the dispatch lease while executor.start is still pending"

echo "[repro] passed"
