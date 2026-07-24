#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "Repro: repo rebind must clear persisted conversation state"
if pnpm --filter @invoker/surfaces test -- src/__tests__/slack-surface-workflows.test.ts -t "clears persisted conversation state when rebinding a thread repo"; then
  echo "PASS: repo rebind clears persisted conversation state"
else
  echo "FAIL: repo rebind left persisted conversation state behind"
  exit 1
fi
