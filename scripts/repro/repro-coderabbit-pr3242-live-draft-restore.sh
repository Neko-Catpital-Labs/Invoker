#!/usr/bin/env bash
# Repro: delayed planningChatList hydration must not overwrite a local planning draft.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "==> Running delayed planning restore draft-preservation repro"
if pnpm --filter @invoker/ui exec vitest run src/__tests__/invoker-terminal.test.tsx -t "keeps a local planning draft when backend restore resolves later"; then
  echo "PASS: delayed backend restore preserves the local planning draft."
else
  echo "FAIL: delayed backend restore overwrote the local planning draft." >&2
  exit 1
fi
