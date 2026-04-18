#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

echo "==> Repro: global top-up does not double dispatch with taskDispatcher wiring"
echo "This guards the live symptom shape where one globally-ready task was being launched twice."
echo

pnpm --filter @invoker/app exec vitest run \
  src/__tests__/bridge-orchestrator-executor.test.ts \
  --testNamePattern "dispatches each runnable task only once when taskDispatcher is wired"
