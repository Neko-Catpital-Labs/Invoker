#!/usr/bin/env bash
# Stress proof for uncapped cross-workflow mutation draining.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"

# 32 independent workflows each spend 25ms in the handler. Serial draining
# would take ~800ms; the 400ms bound proves meaningful cross-workflow overlap.
bash "$ROOT/scripts/bench-workflow-drain-queue.sh" \
  --workflows 32 \
  --drain-ms 25 \
  --max-queue-wait-ms 100 \
  --max-elapsed-ms 400 \
  --timeout 30
