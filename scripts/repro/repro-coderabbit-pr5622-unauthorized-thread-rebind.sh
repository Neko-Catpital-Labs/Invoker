#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "Repro: non-owners must not be able to rebind a thread to a different repo"
if pnpm --filter @invoker/surfaces test -- src/__tests__/slack-surface-workflows.test.ts -t "refuses a repo rebind from a different non-admin participant"; then
  echo "PASS: non-owners cannot rebind a thread repo"
else
  echo "FAIL: a different non-admin participant rebound the thread repo"
  exit 1
fi
