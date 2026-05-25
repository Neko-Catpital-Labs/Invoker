#!/usr/bin/env bash
#
# Deterministic repro for UI entry-chunk bundle size.
#
# The production Vite build currently produces a ~1.77 MB entry chunk
# (index-*.js) that is loaded synchronously at app startup. This is a
# cold-start parse/evaluation risk independent of graph-layout cost.
#
# The build splits vendor code into manual chunks (react, xyflow, xterm)
# via vite.config.ts manualChunks; whatever remains in the entry chunk
# is application code plus any un-split vendor modules.
#
# This script builds @invoker/ui, inspects packages/ui/dist/assets,
# prints raw and gzip sizes for every JS chunk, and enforces an explicit
# budget on the entry chunk.
#
# Budget: 1500 KB raw  (1 536 000 bytes)
#
# Modes:
#   --expect-issue   PASS when the entry chunk EXCEEDS the budget
#                    (confirms the issue exists before the fix).
#   (default)        PASS only when the entry chunk is UNDER budget
#                    (validates the optimization).

set -euo pipefail

EXPECT_ISSUE=0
BUDGET_KB=1500
BUDGET_BYTES=$(( BUDGET_KB * 1024 ))

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue   PASS when the entry chunk exceeds the budget
                   (baseline mode, before the optimization).
  --budget-kb N    Override entry-chunk budget in KB (default: ${BUDGET_KB}).
  -h, --help       Show this help.
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue)  EXPECT_ISSUE=1 ;;
    --budget-kb)     shift; BUDGET_KB="$1"; BUDGET_BYTES=$(( BUDGET_KB * 1024 )) ;;
    --budget-kb=*)   BUDGET_KB="${1#*=}"; BUDGET_BYTES=$(( BUDGET_KB * 1024 )) ;;
    -h|--help)       usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_ASSETS="$REPO_ROOT/packages/ui/dist/assets"

echo "repro: building @invoker/ui..."
(cd "$REPO_ROOT" && pnpm --filter @invoker/ui build 2>&1) | tail -n 30

if [[ ! -d "$DIST_ASSETS" ]]; then
  echo "repro: FAIL -- dist/assets directory not found at $DIST_ASSETS" >&2
  exit 1
fi

# Collect every JS file in dist/assets.
mapfile -t JS_FILES < <(find "$DIST_ASSETS" -maxdepth 1 -name '*.js' -type f | sort)

if [[ ${#JS_FILES[@]} -eq 0 ]]; then
  echo "repro: FAIL -- no JS files found in $DIST_ASSETS" >&2
  exit 1
fi

# Known vendor chunk prefixes from vite.config.ts manualChunks.
VENDOR_PREFIXES=("react-" "xyflow-" "xterm-" "elkjs-")

is_vendor_chunk() {
  local basename="$1"
  for prefix in "${VENDOR_PREFIXES[@]}"; do
    if [[ "$basename" == "$prefix"* ]]; then
      return 0
    fi
  done
  return 1
}

fmt_size() {
  local bytes="$1"
  if (( bytes >= 1048576 )); then
    awk "BEGIN { printf \"%.2f MB\", $bytes / 1048576 }"
  elif (( bytes >= 1024 )); then
    awk "BEGIN { printf \"%.1f KB\", $bytes / 1024 }"
  else
    echo "${bytes} B"
  fi
}

echo ""
echo "── Bundle chunk report ──────────────────────────────────"
printf "%-40s %12s %12s\n" "Chunk" "Raw" "Gzip"
echo "────────────────────────────────────────────────────────────────────"

ENTRY_CHUNK=""
ENTRY_RAW=0

for js_file in "${JS_FILES[@]}"; do
  basename="$(basename "$js_file")"
  raw_bytes="$(wc -c < "$js_file" | tr -d ' ')"
  gzip_bytes="$(gzip -c "$js_file" | wc -c | tr -d ' ')"

  raw_fmt="$(fmt_size "$raw_bytes")"
  gzip_fmt="$(fmt_size "$gzip_bytes")"

  label="$basename"
  if is_vendor_chunk "$basename"; then
    label="$basename (vendor)"
  fi

  printf "%-40s %12s %12s\n" "$label" "$raw_fmt" "$gzip_fmt"

  if ! is_vendor_chunk "$basename"; then
    if [[ -z "$ENTRY_CHUNK" ]] || (( raw_bytes > ENTRY_RAW )); then
      ENTRY_CHUNK="$basename"
      ENTRY_RAW="$raw_bytes"
    fi
  fi
done

echo "────────────────────────────────────────────────────────────────────"
echo ""

if [[ -z "$ENTRY_CHUNK" ]]; then
  echo "repro: FAIL -- could not identify the entry chunk" >&2
  exit 1
fi

ENTRY_RAW_FMT="$(fmt_size "$ENTRY_RAW")"
BUDGET_FMT="$(fmt_size "$BUDGET_BYTES")"
OVER_BUDGET=$(( ENTRY_RAW > BUDGET_BYTES ? 1 : 0 ))

echo "Entry chunk:  $ENTRY_CHUNK"
echo "Entry size:   $ENTRY_RAW_FMT ($ENTRY_RAW bytes)"
echo "Budget:       $BUDGET_FMT ($BUDGET_BYTES bytes)"
echo ""

if (( EXPECT_ISSUE )); then
  if (( OVER_BUDGET )); then
    echo "repro: PASS (--expect-issue) -- entry chunk ($ENTRY_RAW_FMT) exceeds budget ($BUDGET_FMT)"
    exit 0
  fi
  echo "repro: FAIL (--expect-issue) -- entry chunk ($ENTRY_RAW_FMT) is within budget ($BUDGET_FMT); the issue appears already fixed" >&2
  exit 1
fi

if (( OVER_BUDGET )); then
  echo "repro: FAIL -- entry chunk ($ENTRY_RAW_FMT) exceeds budget ($BUDGET_FMT)" >&2
  exit 1
fi

echo "repro: PASS -- entry chunk ($ENTRY_RAW_FMT) is within budget ($BUDGET_FMT)"
exit 0
