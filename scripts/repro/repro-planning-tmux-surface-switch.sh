#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "[repro] Running planning tmux hidden-output preservation test."
if pnpm --filter @invoker/ui test -- src/__tests__/planning-terminal-tmux.test.tsx -t "restores planning tmux output emitted while the planning terminal surface is hidden"; then
  echo "PASS"
else
  echo "FAIL" >&2
  exit 1
fi
