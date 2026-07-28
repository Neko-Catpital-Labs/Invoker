#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-after}"
case "$MODE" in
  before|after)
    ;;
  *)
    echo "usage: $0 [before|after]" >&2
    exit 64
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "[repro] Building UI package."
pnpm -C "$REPO_ROOT" --filter @invoker/ui build

echo "[repro] Building app package."
pnpm -C "$REPO_ROOT" --filter @invoker/app build

echo "[repro] Running planning tmux blank repro in ${MODE} mode."
INVOKER_PLANNING_TMUX_BLANK_EXPECT="$MODE" \
INVOKER_PLAYWRIGHT_WORKERS=1 \
pnpm -C "$REPO_ROOT" --filter @invoker/app test:e2e -- e2e/planning-tmux-blank-repro.spec.ts --workers=1
