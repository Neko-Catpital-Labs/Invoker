#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-launch-readiness.XXXXXX")"

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
echo "==> lower-stack lifecycle invalidation repro"
bash "$ROOT_DIR/scripts/repro/repro-launch-dispatch-lifecycle-invalidation.sh" \
  >"$TMP_ROOT/lifecycle-invalidation.log" 2>&1
tail -n 12 "$TMP_ROOT/lifecycle-invalidation.log"

echo
echo "==> workflow-core scheduler readiness gates"
(
  cd "$ROOT_DIR"
  pnpm --filter @invoker/workflow-core exec vitest run \
    --reporter verbose \
    --exclude '**/node_modules/**' \
    src/__tests__/orchestrator-dispatcher.test.ts \
    -t 'getTaskLaunchReadiness rejects pending tasks whose local dependencies are not satisfied|drainScheduler drops stale queued jobs whose dependencies are not launch-ready'
)

echo
echo "==> app launch dispatcher readiness gates"
(
  cd "$ROOT_DIR"
  pnpm --filter @invoker/app exec vitest run \
    --reporter verbose \
    --exclude '**/node_modules/**' \
    src/__tests__/launch-dispatcher.test.ts \
    -t 'abandons a dispatch row when the selected attempt changed after lease|abandons the dispatch when readiness is blocked|abandons the dispatch when the orchestrator has no matching task'
)

echo
echo "==> readiness gates repro matched expectation"
