#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-coderabbit-pr4682-valid-timestamps.XXXXXX.log")"
trap 'rm -f "$log_file"' EXIT

echo "[repro] Running PR #4682 worker timestamp validation regression."
echo "[repro] Scenario: all-invalid worker action timestamps render the validated empty state."

if pnpm -C "$repo_root" --filter @invoker/ui exec vitest run \
  src/__tests__/timeline-view-e2e.test.tsx \
  -t "shows invalid timestamp empty state from validated worker rows" \
  >"$log_file" 2>&1; then
  echo "[repro] PASS: invalid worker timestamps produce the validated empty state."
else
  status=$?
  echo "[repro] FAIL: invalid worker timestamps produced the wrong worker timeline state."
  cat "$log_file"
  exit "$status"
fi
