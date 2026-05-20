#!/usr/bin/env bash
# verify-build-warning-clean.sh — fail if the Vite UI build emits noisy warnings.
#
# Production builds historically printed two warnings that made a healthy build
# look broken:
#   1. "Generated an empty chunk: <name>" — manualChunks entries that no module
#      resolved into.
#   2. "Some chunks are larger than 500 kB after minification." — a chunk that
#      crossed Rollup's chunkSizeWarningLimit.
#
# This script runs the UI build under a controlled environment, captures the
# combined stdout/stderr, and exits non-zero if either warning appears.
#
# Usage: bash scripts/verify-build-warning-clean.sh [mode]
#   mode = targeted-builds   build only the UI package (default)
#
set -euo pipefail

MODE="${1:-targeted-builds}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

case "$MODE" in
  targeted-builds)
    BUILD_TARGETS=("@invoker/ui")
    ;;
  *)
    echo "verify-build-warning-clean.sh: unknown mode '$MODE'" >&2
    echo "  supported modes: targeted-builds" >&2
    exit 2
    ;;
esac

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT

status=0
for target in "${BUILD_TARGETS[@]}"; do
  echo "==> building $target" >&2
  if ! pnpm --filter "$target" build >"$LOG" 2>&1; then
    echo "verify-build-warning-clean.sh: build failed for $target" >&2
    cat "$LOG" >&2
    exit 1
  fi
  cat "$LOG"

  if grep -q "Generated an empty chunk" "$LOG"; then
    echo "verify-build-warning-clean.sh: empty-chunk warning detected in $target build" >&2
    grep "Generated an empty chunk" "$LOG" >&2 || true
    status=1
  fi

  if grep -q "Some chunks are larger than" "$LOG"; then
    echo "verify-build-warning-clean.sh: oversized-chunk warning detected in $target build" >&2
    grep "Some chunks are larger than" "$LOG" >&2 || true
    status=1
  fi
done

exit "$status"
