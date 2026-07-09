#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-selected-workflow-graph-repro.XXXXXX.log")"
trap 'rm -f "$log_file"' EXIT

echo "[repro] Running selected workflow mini-DAG metadata-gap regression."
echo "[repro] Scenario: select wf-a, keep wf-a tasks, then publish workflows-changed with only wf-b."

if pnpm -C "$repo_root" --filter @invoker/ui exec vitest run \
  src/__tests__/selected-workflow-graph-disappears-repro.test.tsx \
  >"$log_file" 2>&1; then
  echo "[repro] PASS: selected mini-DAG stayed visible while task state remained present."
  echo "[repro] Regression confirms the UI is resilient to transient workflow metadata gaps."
else
  status=$?
  echo "[repro] FAIL: focused regression did not complete as expected."
  cat "$log_file"
  exit "$status"
fi
