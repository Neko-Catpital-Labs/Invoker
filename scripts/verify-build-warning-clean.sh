#!/usr/bin/env bash
# Verify that targeted production builds emit no Vite chunking warnings.
#
# Today the UI build (packages/ui) is the only known offender. The check fails
# the script if either:
#   - "Generated an empty chunk" warning is present, or
#   - "Some chunks are larger than" oversized-chunk warning is present.
#
# Usage:
#   bash scripts/verify-build-warning-clean.sh targeted-builds
#
# The "targeted-builds" subcommand runs the curated list of package builds that
# currently emit relevant chunk warnings (extend the list below as new
# package builds adopt manual chunking).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-targeted-builds}"
if [[ "$MODE" != "targeted-builds" ]]; then
  echo "Unknown mode: $MODE" >&2
  echo "Usage: bash scripts/verify-build-warning-clean.sh targeted-builds" >&2
  exit 2
fi

TARGETED_PACKAGES=(
  "@invoker/ui"
)

FAIL=0
for pkg in "${TARGETED_PACKAGES[@]}"; do
  echo "==> Building $pkg" >&2
  LOG="$(mktemp)"
  if ! pnpm --filter "$pkg" build >"$LOG" 2>&1; then
    echo "ERROR: build for $pkg exited non-zero. Full output:" >&2
    cat "$LOG" >&2
    rm -f "$LOG"
    exit 1
  fi
  cat "$LOG" >&2
  if grep -q "Generated an empty chunk" "$LOG"; then
    echo "FAIL: $pkg emitted 'Generated an empty chunk' warning." >&2
    FAIL=1
  fi
  if grep -qE "Some chunks are larger than [0-9]+ ?kB" "$LOG"; then
    echo "FAIL: $pkg emitted oversized-chunk warning." >&2
    FAIL=1
  fi
  rm -f "$LOG"
done

if (( FAIL != 0 )); then
  exit 1
fi

echo "OK: no chunk warnings in targeted builds."
