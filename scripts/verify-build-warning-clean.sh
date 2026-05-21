#!/usr/bin/env bash
# Runs targeted production builds and fails if Vite emits the empty-chunk or
# oversized-chunk warnings the launch checker complains about.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MODE="${1:-targeted-builds}"

case "$MODE" in
  targeted-builds)
    BUILDS=("@invoker/ui")
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    echo "Usage: $0 [targeted-builds]" >&2
    exit 2
    ;;
esac

EMPTY_RE='Generated an empty chunk'
OVERSIZE_RE='Some chunks are larger than'

fail=0
for pkg in "${BUILDS[@]}"; do
  echo "==> Building $pkg"
  log="$(mktemp)"
  trap 'rm -f "$log"' EXIT
  if ! pnpm --filter "$pkg" build 2>&1 | tee "$log"; then
    echo "Build for $pkg failed" >&2
    fail=1
    rm -f "$log"
    trap - EXIT
    continue
  fi
  if grep -qE "$EMPTY_RE" "$log"; then
    echo "FAIL: $pkg emitted an empty-chunk warning" >&2
    fail=1
  fi
  if grep -qE "$OVERSIZE_RE" "$log"; then
    echo "FAIL: $pkg emitted an oversized-chunk warning" >&2
    fail=1
  fi
  rm -f "$log"
  trap - EXIT
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "All targeted builds completed with no empty-chunk or oversized-chunk warnings."
