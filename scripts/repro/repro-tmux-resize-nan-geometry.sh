#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "[repro] Running tmux resize non-finite geometry guard repro."
if pnpm --filter @invoker/ui test -- src/__tests__/invoker-terminal.test.tsx -t "skips planning tmux fit and resize when proposed dimensions are not finite"; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi
