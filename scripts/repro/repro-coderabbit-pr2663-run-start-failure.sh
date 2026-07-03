#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-pr2663-run-start.XXXXXX.log")"
trap 'rm -f "$log_file"' EXIT

echo "[repro] Running PR #2663 run-start failure regression."

if pnpm -C "$repo_root" --filter @invoker/ui exec vitest run \
  src/__tests__/invoker-terminal.test.tsx \
  -t 'reports start failures instead of a successful run' \
  >"$log_file" 2>&1; then
  echo "[repro] PASS: terminal reports a failed run start as an error."
else
  status=$?
  echo "[repro] FAIL: terminal reported success even though invoker.start failed."
  cat "$log_file"
  exit "$status"
fi
