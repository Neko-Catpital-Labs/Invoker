#!/usr/bin/env bash
# Verifies that the production builds emit no chunking warnings.
#
# Usage:
#   bash scripts/verify-build-warning-clean.sh targeted-builds
#
# `targeted-builds` runs the package builds that previously emitted Vite
# chunk warnings (currently just @invoker/ui — the only Vite build in the
# workspace). It re-runs each build and fails if the output contains any
# "Generated an empty chunk" or "Some chunks are larger than 500 kB"
# (or any "kB after minification") warning.
#
# Add new package builds to TARGETS as more Vite builds appear in the repo.

set -euo pipefail

MODE="${1:-targeted-builds}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TARGETS=(
  "@invoker/ui"
)

check_build_log() {
  local pkg="$1"
  local log="$2"

  local empty_chunk_hits
  empty_chunk_hits=$(grep -c "Generated an empty chunk" "$log" || true)
  local oversized_hits
  oversized_hits=$(grep -cE "chunks are larger than [0-9]+ ?kB" "$log" || true)

  if [[ "$empty_chunk_hits" -gt 0 ]]; then
    echo "FAIL: $pkg build emitted $empty_chunk_hits 'Generated an empty chunk' warning(s)." >&2
    grep "Generated an empty chunk" "$log" >&2 || true
    return 1
  fi
  if [[ "$oversized_hits" -gt 0 ]]; then
    echo "FAIL: $pkg build emitted $oversized_hits chunk-size warning(s)." >&2
    grep -E "chunks are larger than [0-9]+ ?kB" "$log" >&2 || true
    return 1
  fi
  echo "OK: $pkg build has no chunking warnings."
  return 0
}

run_targeted_builds() {
  local rc=0
  for pkg in "${TARGETS[@]}"; do
    local log
    log=$(mktemp)
    echo "==> Building $pkg" >&2
    if ! pnpm --filter "$pkg" build >"$log" 2>&1; then
      echo "FAIL: $pkg build exited non-zero." >&2
      cat "$log" >&2
      rm -f "$log"
      rc=1
      continue
    fi
    if ! check_build_log "$pkg" "$log"; then
      rc=1
    fi
    rm -f "$log"
  done
  return $rc
}

case "$MODE" in
  targeted-builds)
    run_targeted_builds
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    echo "Usage: $0 targeted-builds" >&2
    exit 2
    ;;
esac
