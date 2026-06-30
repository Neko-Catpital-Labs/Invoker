#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

pnpm --filter @invoker/surfaces exec vitest run \
  src/__tests__/lobby-control.test.ts \
  src/__tests__/workflow-assistant.test.ts \
  src/__tests__/slack-surface-workflows.test.ts

pnpm --filter @invoker/app exec vitest run \
  src/__tests__/slack-gate-policy-op.test.ts
