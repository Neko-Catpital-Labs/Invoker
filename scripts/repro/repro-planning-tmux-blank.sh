#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-after}"
case "$MODE" in
  before|after) ;;
  *)
    echo "usage: $0 [before|after]" >&2
    exit 64
    ;;
esac

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
ARTIFACT_DIR="${INVOKER_PLANNING_TMUX_BLANK_ARTIFACT_DIR:-$ROOT_DIR/packages/app/test-results/planning-tmux-blank-repro/$MODE-$RUN_ID}"
ARTIFACT_JSON="$ARTIFACT_DIR/planning-tmux-blank-$MODE.json"

echo "[repro] mode=$MODE"
echo "[repro] artifacts=$ARTIFACT_DIR"
echo "[repro] building UI and Electron app"
pnpm -C "$ROOT_DIR" --filter @invoker/ui build
pnpm -C "$ROOT_DIR" --filter @invoker/app build

echo "[repro] running focused Playwright spec with one worker"
(
  cd "$ROOT_DIR/packages/app"
  INVOKER_PLANNING_TMUX_BLANK_EXPECT="$MODE" \
    INVOKER_PLANNING_TMUX_BLANK_ARTIFACT_DIR="$ARTIFACT_DIR" \
    INVOKER_PLAYWRIGHT_WORKERS=1 \
    pnpm run test:e2e -- e2e/planning-tmux-blank-repro.spec.ts --workers=1
)

if [[ ! -f "$ARTIFACT_JSON" ]]; then
  echo "[repro] expected artifact was not written: $ARTIFACT_JSON" >&2
  exit 1
fi

if [[ "$MODE" == "before" ]]; then
  printf 'BUG_REPRODUCED=%s\n' "$(tr -d '\n' < "$ARTIFACT_JSON")"
else
  printf 'FIX_VERIFIED=%s\n' "$(tr -d '\n' < "$ARTIFACT_JSON")"
fi
