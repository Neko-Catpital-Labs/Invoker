#!/usr/bin/env bash
# Repro: headless `start-ready --no-track` must not die with workflow-not-resolved.
#
# Root cause (pre-fix):
#   acknowledgeNoTrackHeadlessExec requires a workflowId to queue fire-and-forget
#   headless.exec intents. classifyHeadlessExecMutation leaves start-ready as
#   workflow=<none> because it is a global command. Result:
#     Fire-and-forget headless.exec could not be queued: workflow-not-resolved
#
# Fix:
#   start-ready noTrack falls through to inline executeHeadlessExec, and logs
#   `headless.exec start-ready noTrack fallthrough`.
#
# Usage:
#   bash scripts/repro/repro-start-ready-no-track-global.sh
#   bash scripts/repro/repro-start-ready-no-track-global.sh --gate
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

GATE=0
for arg in "$@"; do
  case "$arg" in
    --gate) GATE=1 ;;
  esac
done

echo "[repro] unit proof: acknowledgeNoTrackHeadlessExec start-ready fallthrough"
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/acknowledge-no-track-start-ready.test.ts \
  src/__tests__/owner-delegation.test.ts -t "start-ready|global start-ready"

echo "[repro] timeout policy proof: start-ready uses 60s delegation timeout"
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/owner-delegation.test.ts -t "uses 60s timeout for global start-ready"

if [[ "$GATE" -eq 1 ]]; then
  echo "[repro] GATE ok"
fi
echo "[repro] PASS"
