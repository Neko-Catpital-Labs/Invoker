#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-pr2663-planned-graph.XXXXXX.log")"
trap 'rm -f "$log_file"' EXIT

echo "[repro] Running PR #2663 planned graph refresh regression."

if pnpm -C "$repo_root" --filter @invoker/ui exec vitest run \
  src/__tests__/invoker-terminal.test.tsx \
  -t 'refreshes the graph from the planned snapshot after plan generation' \
  >"$log_file" 2>&1; then
  echo "[repro] PASS: planFromGoal refresh publishes the planned graph snapshot."
else
  status=$?
  echo "[repro] FAIL: planFromGoal left the app on a stale graph snapshot."
  cat "$log_file"
  exit "$status"
fi
