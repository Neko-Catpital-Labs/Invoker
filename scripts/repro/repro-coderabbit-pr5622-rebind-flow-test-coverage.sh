#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "Repro: persisted-conversation cleanup must be exercised through the rebind flow"
TEST_FILE="packages/surfaces/src/__tests__/slack-surface-workflows.test.ts"
if grep -q 'discardThreadSession.discardThreadSession(' "$TEST_FILE"; then
  echo "FAIL: test bypasses maybeRebindThreadRepo by calling discardThreadSession directly"
  exit 1
fi
if pnpm --filter @invoker/surfaces test -- src/__tests__/slack-surface-workflows.test.ts -t "clears persisted conversation state when rebinding a thread repo"; then
  echo "PASS: authorized follow-up rebind clears persisted conversation state"
else
  echo "FAIL: follow-up rebind flow did not clear persisted conversation state"
  exit 1
fi
