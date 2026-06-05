#!/usr/bin/env bash
# Periodic snapshot of queue + workflow stats for the autofix loop.
# Logs a single JSON line per snapshot to make tailing easy.
#
# Usage: bash scripts/monitor-loop-status.sh [interval_seconds]
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$ROOT_DIR/scripts/electron.cjs"
MAIN="$ROOT_DIR/packages/app/dist/main.js"

INTERVAL="${1:-120}"

snapshot() {
  local now queue stats
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  queue="$("$ELECTRON" "$MAIN" --headless query queue --output json 2>/dev/null || echo '{}')"
  stats="$("$ELECTRON" "$MAIN" --headless query stats --output json 2>/dev/null || echo '{}')"

  python3 - "$now" "$queue" "$stats" <<'PY'
import json
import sys

now = sys.argv[1]
queue = json.loads(sys.argv[2] or "{}")
stats = json.loads(sys.argv[3] or "{}")

running_count = queue.get("runningCount") if isinstance(queue, dict) else None
running_list = queue.get("running") if isinstance(queue, dict) else None
running_ids = [r.get("taskId") for r in running_list] if isinstance(running_list, list) else []

snapshot = {
    "time": now,
    "runningCount": running_count,
    "runningTasks": running_ids,
    "workflowsTotal": stats.get("totalWorkflows"),
    "workflowsCompleted": stats.get("completed"),
    "workflowsFailed": stats.get("failed"),
    "workflowsRunning": stats.get("running"),
    "successRatePct": stats.get("successRate"),
}
print(json.dumps(snapshot))
PY
}

echo "[monitor] starting interval=${INTERVAL}s pid=$$"
while :; do
  snapshot
  sleep "$INTERVAL"
done
