#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-coderabbit-pr4682-accessibility.XXXXXX.log")"
trap 'rm -f "$log_file"' EXIT

echo "[repro] Running PR #4682 timeline control accessibility regression."
echo "[repro] Scenario: timeline mode controls and worker search controls expose accessible names."

if pnpm -C "$repo_root" --filter @invoker/ui exec vitest run \
  src/__tests__/timeline-view-e2e.test.tsx \
  -t "labels timeline mode and worker search controls for assistive technology" \
  >"$log_file" 2>&1; then
  echo "[repro] PASS: timeline controls expose consistent accessible semantics."
else
  status=$?
  echo "[repro] FAIL: timeline controls are missing required accessible semantics."
  cat "$log_file"
  exit "$status"
fi
