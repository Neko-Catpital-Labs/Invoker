#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-pr2663-graph-placeholder.XXXXXX.log")"
trap 'rm -f "$log_file"' EXIT

echo "[repro] Running PR #2663 graph placeholder assertion regression."

if pnpm -C "$repo_root" --filter @invoker/ui exec vitest run \
  src/__tests__/app-launch.test.tsx \
  -t 'shows the reskinned empty shell when no plan is loaded' \
  >"$log_file" 2>&1; then
  echo "[repro] PASS: empty-state copy is asserted inside the workflow graph surface."
else
  status=$?
  echo "[repro] FAIL: empty-state copy is not proven inside the workflow graph surface."
  cat "$log_file"
  exit "$status"
fi
