#!/usr/bin/env bash
# Verify that targeted production builds finish without Rollup chunk
# warnings (no empty chunks and no chunks above the 500 kB threshold).
#
# Usage:
#   bash scripts/verify-build-warning-clean.sh targeted-builds
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

MODE="${1:-targeted-builds}"

run_build() {
  local label="$1"
  shift
  local log
  log="$(mktemp)"

  echo "==> $label"
  if ! "$@" >"$log" 2>&1; then
    echo "FAIL: $label exited non-zero"
    cat "$log"
    rm -f "$log"
    exit 1
  fi

  if grep -q "Generated an empty chunk" "$log"; then
    echo "FAIL: $label emitted an empty-chunk warning"
    grep -n "Generated an empty chunk" "$log" || true
    cat "$log"
    rm -f "$log"
    exit 1
  fi

  if grep -q "Some chunks are larger than" "$log"; then
    echo "FAIL: $label emitted an oversized-chunk warning"
    grep -n "Some chunks are larger than" "$log" || true
    cat "$log"
    rm -f "$log"
    exit 1
  fi

  echo "    OK: no chunk warnings"
  rm -f "$log"
}

case "$MODE" in
  targeted-builds)
    run_build "pnpm --filter @invoker/ui build" pnpm --filter @invoker/ui build
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    echo "Usage: $0 targeted-builds" >&2
    exit 2
    ;;
esac

echo ""
echo "==> verify-build-warning-clean ($MODE): PASS"
