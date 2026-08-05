#!/usr/bin/env bash
# Gate: workflow submission latency must not regress past p95 1s under a
# storm of 50 rapid submissions (packages/transport IpcBus reconnect fix).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"
exec bash "$ROOT/scripts/bench-workflow-submission-storm.sh" --gate
