#!/usr/bin/env bash
# Regression proof for merge gates running as normal executor actions.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT/packages/execution-engine"
exec pnpm exec vitest run src/__tests__/task-runner.test.ts \
  -t "starts an independent merge gate while another merge gate is still preparing review"
