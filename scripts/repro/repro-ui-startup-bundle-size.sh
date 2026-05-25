#!/usr/bin/env bash
set -euo pipefail

# Budget: entry chunk must be under this threshold after optimization.
# Current production entry chunk is ~1.77 MB; target is sub-1.5 MB.
ENTRY_BUDGET_KB=1500

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIST_ASSETS="$REPO_ROOT/packages/ui/dist/assets"

EXPECT_ISSUE=false
if [[ "${1:-}" == "--expect-issue" ]]; then
  EXPECT_ISSUE=true
fi

echo "=== UI Bundle Size Repro ==="
echo "Budget: entry chunk < ${ENTRY_BUDGET_KB} KB"
echo "Mode:   $(if $EXPECT_ISSUE; then echo '--expect-issue (pre-fix: expect over budget)'; else echo 'post-fix (expect under budget)'; fi)"
echo ""

# Build the UI package
echo "--- Building @invoker/ui ---"
pnpm --filter @invoker/ui build

if [[ ! -d "$DIST_ASSETS" ]]; then
  echo "ERROR: dist/assets directory not found at $DIST_ASSETS"
  exit 1
fi

echo ""
echo "--- Bundle Sizes ---"
printf "%-50s %10s %10s\n" "CHUNK" "RAW (KB)" "GZIP (KB)"
printf "%-50s %10s %10s\n" "-----" "--------" "---------"

entry_chunk=""
entry_size_kb=0

for file in "$DIST_ASSETS"/*.js; do
  [[ -f "$file" ]] || continue
  basename_file="$(basename "$file")"
  raw_bytes="$(wc -c < "$file" | tr -d ' ')"
  gzip_bytes="$(gzip -c "$file" | wc -c | tr -d ' ')"
  raw_kb=$(( raw_bytes / 1024 ))
  gzip_kb=$(( gzip_bytes / 1024 ))

  printf "%-50s %10d %10d\n" "$basename_file" "$raw_kb" "$gzip_kb"

  # The entry chunk is the index-*.js file (not a named manual chunk)
  if [[ "$basename_file" == index-* ]]; then
    entry_chunk="$basename_file"
    entry_size_kb=$raw_kb
  fi
done

echo ""

if [[ -z "$entry_chunk" ]]; then
  echo "ERROR: Could not identify entry chunk (expected index-*.js)"
  exit 1
fi

echo "Entry chunk: $entry_chunk (${entry_size_kb} KB)"
echo "Budget:      ${ENTRY_BUDGET_KB} KB"

if (( entry_size_kb > ENTRY_BUDGET_KB )); then
  echo "RESULT: OVER BUDGET by $(( entry_size_kb - ENTRY_BUDGET_KB )) KB"
  if $EXPECT_ISSUE; then
    echo "PASS (--expect-issue): entry chunk exceeds budget as expected before fix."
    exit 0
  else
    echo "FAIL: entry chunk exceeds budget. Optimization required."
    exit 1
  fi
else
  echo "RESULT: UNDER BUDGET by $(( ENTRY_BUDGET_KB - entry_size_kb )) KB"
  if $EXPECT_ISSUE; then
    echo "FAIL (--expect-issue): expected entry chunk to exceed budget, but it does not."
    exit 1
  else
    echo "PASS: entry chunk is within budget."
    exit 0
  fi
fi
