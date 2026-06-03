#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-launch-lifecycle.XXXXXX")"

cleanup() {
  local ec=$?
  if [[ "${REPRO_KEEP_TMP:-0}" != "1" ]]; then
    rm -rf "$TMP_ROOT"
  else
    echo "repro: kept temp root: $TMP_ROOT"
  fi
  return "$ec"
}
trap cleanup EXIT

echo "temp_root : $TMP_ROOT"

echo
echo "==> stale downstream dispatch temp-DB repro"
bash "$ROOT_DIR/scripts/repro/repro-stale-downstream-launch-dispatch.sh" --expect-fixed \
  >"$TMP_ROOT/stale-downstream.log" 2>&1
tail -n 8 "$TMP_ROOT/stale-downstream.log"

echo
echo "==> SQLite lifecycle invalidation hooks"
(
  cd "$ROOT_DIR"
  pnpm --filter @invoker/data-store exec vitest run \
    --reporter verbose \
    --exclude '**/node_modules/**' \
    src/__tests__/sqlite-adapter.test.ts \
    -t 'abandonLaunchDispatchesForTasks|releaseExecutionResourceLeasesForTasks'
)

echo
echo "==> orchestrator lifecycle invalidation"
(
  cd "$ROOT_DIR"
  pnpm --filter @invoker/workflow-core exec vitest run \
    --reporter verbose \
    --exclude '**/node_modules/**' \
    src/__tests__/orchestrator-dispatcher.test.ts \
    -t 'invalidates downstream launch dispatches and leases when retryTask resets the subgraph|invalidates launch dispatches and leases when cancelling a workflow'
)

echo
echo "==> lifecycle invalidation repro matched expectation"
