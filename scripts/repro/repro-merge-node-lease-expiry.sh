#!/usr/bin/env bash
# Repro/proof: merge-node post-launch execution must renew the selected
# attempt heartbeat lease while merge consolidation is still running.
#
# This wrapper runs the committed task-runner regressions that cover:
# 1. long-running merge consolidation continues to renew heartbeat/lease
# 2. long-running merge failure also renews heartbeat/lease before failing
#
# Usage:
#   bash scripts/repro/repro-merge-node-lease-expiry.sh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "==> repro: merge-node lease heartbeat coverage"
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner.test.ts \
  --testNamePattern "renews selected attempt heartbeat while merge consolidation is still running|renews selected attempt heartbeat before a long-running merge failure"

echo
echo "repro result:"
echo "- merge-node post-launch execution renews lastHeartbeatAt/leaseExpiresAt"
echo "- the renewal happens while merge consolidation is still running"
echo "- the renewal also happens on long-running merge failure paths"
echo
echo "This proves merge work no longer silently outlives the 5-minute attempt"
echo "lease without heartbeat updates."
