#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] running all PR #2202 CodeRabbit Crabbox cleanup regressions"
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-fix-publish-and-ssh.test.ts \
  -t "crabbox cleanup policy" \
  --reporter=verbose

echo "PASS: all Crabbox cleanup regressions are covered"
