#!/usr/bin/env bash
# Run the targeted Vite builds and assert the output is free of the
# "Generated an empty chunk" and "Some chunks are larger than 500 kB"
# warnings. Exits non-zero if either warning resurfaces.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

MODE="${1:-targeted-builds}"

case "$MODE" in
  targeted-builds)
    BUILDS=("pnpm --filter @invoker/ui build")
    ;;
  *)
    echo "FAIL: unknown mode '$MODE' (expected 'targeted-builds')" >&2
    exit 2
    ;;
esac

EMPTY_CHUNK_PATTERN='Generated an empty chunk'
OVERSIZED_PATTERN='Some chunks are larger than'

overall_status=0

for cmd in "${BUILDS[@]}"; do
  echo "==> Running: $cmd"
  log_file=$(mktemp)
  trap 'rm -f "$log_file"' EXIT

  if ! eval "$cmd" >"$log_file" 2>&1; then
    cat "$log_file"
    echo "FAIL: build command exited non-zero: $cmd" >&2
    overall_status=1
    continue
  fi

  if grep -F -q "$EMPTY_CHUNK_PATTERN" "$log_file"; then
    cat "$log_file"
    echo "FAIL: empty chunk warning emitted by: $cmd" >&2
    overall_status=1
  fi

  if grep -F -q "$OVERSIZED_PATTERN" "$log_file"; then
    cat "$log_file"
    echo "FAIL: oversized chunk warning emitted by: $cmd" >&2
    overall_status=1
  fi

  rm -f "$log_file"
  trap - EXIT
done

if [ "$overall_status" -eq 0 ]; then
  echo "==> Build warning check: PASS"
fi

exit "$overall_status"
