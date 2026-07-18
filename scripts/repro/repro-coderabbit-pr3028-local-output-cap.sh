#!/usr/bin/env bash
# Repro: CodeRabbit PR #3028 (Stability, Major) — cap local command output while
# streaming, not only when formatting. Before the fix, `runLocalCommand()` concatenated
# the full stdout/stderr in memory; `formatLocalCommandResult()` only trimmed to 12k
# afterward, so a noisy command could exhaust the process before formatting ran.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] problem: runLocalCommand buffered unbounded stdout/stderr before formatting"
if pnpm --filter @invoker/surfaces exec vitest run \
  src/__tests__/slack-surface-workflows.test.ts \
  -t "caps captured stdout" --reporter=verbose; then
  echo "[repro] PASS: streamed stdout is bounded while the command runs"
  exit 0
fi

echo "[repro] FAIL: streamed stdout still grows unbounded in memory"
exit 1
