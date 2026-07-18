#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-coderabbit-pr4682-workflow-identity.XXXXXX.log")"
trap 'rm -f "$log_file"' EXIT

echo "[repro] Running PR #4682 workflow identity grace regression."
echo "[repro] Scenario: Workers mode must keep requesting the selected workflow while metadata is temporarily missing."

if pnpm -C "$repo_root" --filter @invoker/ui exec vitest run \
  src/__tests__/timeline-view-e2e.test.tsx \
  -t "keeps Workers scoped to the selected workflow during workflow metadata grace" \
  >"$log_file" 2>&1; then
  echo "[repro] PASS: Workers mode retained the selected workflow ID through the metadata gap."
else
  status=$?
  echo "[repro] FAIL: Workers mode switched away from the selected workflow during the metadata gap."
  cat "$log_file"
  exit "$status"
fi
