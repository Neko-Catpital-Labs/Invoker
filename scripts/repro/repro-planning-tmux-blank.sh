#!/usr/bin/env bash
# Repro: a hidden/zero-sized planning tmux host must not resize the live PTY
# down to tiny geometry. In before mode, this proves the pre-fix defect by
# requiring both resize IPC and `stty size` evidence of tiny geometry.
set -euo pipefail

MODE="${1:-after}"
if [[ "$MODE" != "before" && "$MODE" != "after" ]]; then
  echo "usage: $0 [before|after]" >&2
  exit 64
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> Building UI"
pnpm --filter @invoker/ui build

echo "==> Building app"
pnpm --filter @invoker/app build

echo "==> Running planning tmux blank repro ($MODE)"
(
  cd "$ROOT/packages/app"
  INVOKER_PLANNING_TMUX_BLANK_EXPECT="$MODE" \
  INVOKER_PLAYWRIGHT_WORKERS=1 \
    pnpm run test:e2e e2e/planning-tmux-blank-repro.spec.ts --workers=1
)
