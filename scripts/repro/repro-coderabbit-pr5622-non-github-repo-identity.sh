#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "Repro: equivalent non-GitHub repo URLs must not be treated as different thread bindings"
if pnpm --filter @invoker/surfaces test -- src/__tests__/slack-surface-workflows.test.ts -t "accepts an equivalent non-GitHub repo URL in a thread mention"; then
  echo "PASS: equivalent non-GitHub repo URLs stay bound to the same thread repo"
else
  echo "FAIL: equivalent non-GitHub repo URLs were treated as different repositories"
  exit 1
fi
