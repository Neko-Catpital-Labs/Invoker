#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-after}"
case "$MODE" in
  before|after)
    ;;
  *)
    echo "Usage: $0 [before|after]" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SPEC_FILE="$REPO_ROOT/packages/app/e2e/planning-tmux-blank-repro.spec.ts"
ARTIFACT_DIR="${INVOKER_PLANNING_TMUX_BLANK_ARTIFACT_DIR:-$REPO_ROOT/packages/app/test-results/planning-tmux-blank-repro-$MODE-$(date -u +%Y%m%dT%H%M%SZ)-$$}"
JSON_ARTIFACT="$ARTIFACT_DIR/planning-tmux-blank-repro.json"
MARKER="FIX_VERIFIED"
if [[ "$MODE" == "before" ]]; then
  MARKER="BUG_REPRODUCED"
fi

mkdir -p "$ARTIFACT_DIR"

echo "[repro] Building UI."
pnpm -C "$REPO_ROOT" --filter @invoker/ui build

echo "[repro] Building app."
pnpm -C "$REPO_ROOT" --filter @invoker/app build

echo "[repro] Running planning tmux blank repro in $MODE mode."
INVOKER_PLANNING_TMUX_BLANK_EXPECT="$MODE" \
INVOKER_PLANNING_TMUX_BLANK_ARTIFACT_DIR="$ARTIFACT_DIR" \
INVOKER_PLAYWRIGHT_WORKERS=1 \
  pnpm -C "$REPO_ROOT/packages/app" run test:e2e -- "$SPEC_FILE" --workers=1

if [[ ! -f "$JSON_ARTIFACT" ]]; then
  echo "[repro] Expected artifact was not written: $JSON_ARTIFACT" >&2
  exit 1
fi

COMPACT_JSON="$(node - "$JSON_ARTIFACT" <<'NODE'
const fs = require('node:fs');
const [artifactPath] = process.argv.slice(2);
process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(artifactPath, 'utf8'))));
NODE
)"

echo "$MARKER=$COMPACT_JSON"
