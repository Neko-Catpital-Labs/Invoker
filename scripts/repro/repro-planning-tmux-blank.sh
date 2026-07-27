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
cd "$REPO_ROOT"

echo "==> Building @invoker/ui"
pnpm --filter @invoker/ui build

echo "==> Building @invoker/app"
pnpm --filter @invoker/app build

echo "==> Running planning tmux blank repro ($MODE)"
run_playwright() {
  (
    cd "$REPO_ROOT/packages/app"
    INVOKER_PLANNING_TMUX_BLANK_EXPECT="$MODE" \
    INVOKER_PLAYWRIGHT_WORKERS=1 \
    pnpm exec playwright test e2e/planning-tmux-blank-repro.spec.ts --workers=1
  )
}

if [[ "$(uname -s)" == "Linux" && -z "${DISPLAY:-}" && -x "$(command -v xvfb-run || true)" ]]; then
  XVFB_START="${INVOKER_REPRO_XVFB_SERVER_NUM:-220}"
  XVFB_AUTH_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-planning-tmux-xauth.XXXXXX")"
  XVFB_ERROR_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-planning-tmux-xvfb.XXXXXX")"
  rm -f "$XVFB_AUTH_FILE"
  set +e
  xvfb-run \
    --auto-servernum \
    --server-num="$XVFB_START" \
    --auth-file="$XVFB_AUTH_FILE" \
    --error-file="$XVFB_ERROR_FILE" \
    --server-args="-screen 0 1280x1024x24" \
    bash -lc "$(declare -f run_playwright); REPO_ROOT='$REPO_ROOT' MODE='$MODE'; run_playwright"
  status=$?
  set -e
  if [[ $status -ne 0 && -s "$XVFB_ERROR_FILE" ]]; then
    echo "==> Xvfb diagnostics" >&2
    sed -n '1,120p' "$XVFB_ERROR_FILE" >&2
  fi
  rm -f "$XVFB_AUTH_FILE" "$XVFB_ERROR_FILE"
  exit "$status"
fi

run_playwright
