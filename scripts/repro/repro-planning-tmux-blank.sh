#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-after}"

if [[ "$MODE" != "before" && "$MODE" != "after" ]]; then
  echo "usage: $0 [before|after]" >&2
  exit 2
fi

echo "Building UI and Electron app..."
(cd "$ROOT_DIR" && pnpm --filter @invoker/ui build && pnpm --filter @invoker/app build)

echo "Running planning tmux blank repro in ${MODE} mode..."
(
  cd "$ROOT_DIR/packages/app"
  INVOKER_PLANNING_TMUX_BLANK_EXPECT="$MODE" \
    INVOKER_PLAYWRIGHT_WORKERS=1 \
    INVOKER_PLAYWRIGHT_RETRIES=0 \
    pnpm run test:e2e -- e2e/planning-tmux-blank-repro.spec.ts --workers=1
)
