#!/usr/bin/env bash
# Verifies that targeted production builds emit none of the Vite chunking
# warnings that previously masked legitimate regressions:
#
#   * "Generated an empty chunk"          (manual chunk that matched no module)
#   * "Some chunks are larger than 500 kB" (oversized chunk after minify)
#
# Run the script from the repo root:
#
#   bash scripts/verify-build-warning-clean.sh targeted-builds
#
# The "targeted-builds" mode runs `pnpm --filter @invoker/ui build` and scans
# its combined stdout/stderr for either warning. Any future build target that
# needs the same hygiene check can be added under a new mode label.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-targeted-builds}"

EMPTY_PATTERN='Generated an empty chunk'
OVERSIZE_PATTERN='Some chunks are larger than 500 kB'

run_build() {
  local label="$1"
  shift
  echo "==> [$label] $*"
  local log
  log="$(mktemp)"
  if ! "$@" >"$log" 2>&1; then
    echo "FAIL: build command exited non-zero for $label" >&2
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
  local failed=0
  if grep -F "$EMPTY_PATTERN" "$log" >/dev/null; then
    echo "FAIL: $label build emitted an empty-chunk warning" >&2
    grep -F "$EMPTY_PATTERN" "$log" >&2
    failed=1
  fi
  if grep -F "$OVERSIZE_PATTERN" "$log" >/dev/null; then
    echo "FAIL: $label build emitted an oversized-chunk warning" >&2
    grep -F "$OVERSIZE_PATTERN" "$log" >&2
    failed=1
  fi
  if [[ $failed -ne 0 ]]; then
    echo "--- full build log ---" >&2
    cat "$log" >&2
    rm -f "$log"
    return 1
  fi
  echo "    OK: $label build is warning-clean"
  rm -f "$log"
  return 0
}

case "$MODE" in
  targeted-builds)
    run_build "@invoker/ui" pnpm --filter @invoker/ui build
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    echo "Usage: $0 [targeted-builds]" >&2
    exit 2
    ;;
esac

echo ""
echo "==> Build warning verification: ALL CHECKS PASSED"
