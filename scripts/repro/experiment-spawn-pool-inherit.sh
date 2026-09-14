#!/usr/bin/env bash
# Repro gate: experiment spawn must inherit pivot poolId.
# Fail-before (unfixed master): vitest it.fails documents missing poolId on spawned variants.
# Pass-after (fix slice): same test without it.fails exits 0.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT/packages/workflow-core"
exec pnpm exec vitest run src/__tests__/repro-experiment-spawn-pool-inherit.test.ts
