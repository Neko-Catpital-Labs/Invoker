#!/usr/bin/env bash
#
# Deterministic repro for the oversized UI entry chunk.
#
# The production Vite build emits an entry chunk (index-*.js) that is
# roughly 1.77 MB raw.  Even with gzip (~350-450 KB), the parse and
# evaluation cost on Electron startup is a plausible cold-start risk
# independent of graph-layout work.
#
# The script builds @invoker/ui, locates every asset in dist/assets,
# prints raw and gzip sizes, then applies an explicit budget to the
# entry chunk.
#
# Budget:
#   ENTRY_RAW_BUDGET_KB   – raw JS budget for the entry chunk (default: 1400).
#
# Modes:
#   --expect-issue   PASS when the entry chunk EXCEEDS the budget
#                    (confirms the problem exists today).
#   (default)        PASS only when the entry chunk is UNDER the budget
#                    (validates the optimization).

set -euo pipefail

EXPECT_ISSUE=0
ENTRY_RAW_BUDGET_KB="${ENTRY_RAW_BUDGET_KB:-1400}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue              PASS only if the entry chunk exceeds the budget
                              (baseline / pre-fix mode).
  --budget-kb N               Raw-KB budget for the entry chunk
                              (default: ${ENTRY_RAW_BUDGET_KB}).
  -h, --help                  Show this help.
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue)       EXPECT_ISSUE=1 ;;
    --budget-kb)          shift; ENTRY_RAW_BUDGET_KB="$1" ;;
    --budget-kb=*)        ENTRY_RAW_BUDGET_KB="${1#*=}" ;;
    -h|--help)            usage; exit 0 ;;
    *)                    echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
  shift
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DIST_ASSETS="packages/ui/dist/assets"

echo "=== Building @invoker/ui ==="
pnpm --filter @invoker/ui build

if [[ ! -d "$DIST_ASSETS" ]]; then
  echo "FAIL: dist/assets directory not found after build." >&2
  exit 1
fi

echo ""
echo "=== Asset sizes ==="
printf "%-50s %10s %10s\n" "FILE" "RAW (KB)" "GZIP (KB)"
printf "%-50s %10s %10s\n" "----" "--------" "--------"

entry_file=""
entry_raw_kb=0

for f in "$DIST_ASSETS"/*; do
  [[ -f "$f" ]] || continue
  fname="$(basename "$f")"
  raw_bytes="$(wc -c < "$f")"
  raw_kb=$(( (raw_bytes + 512) / 1024 ))
  gzip_bytes="$(gzip -c "$f" | wc -c)"
  gzip_kb=$(( (gzip_bytes + 512) / 1024 ))
  printf "%-50s %10d %10d\n" "$fname" "$raw_kb" "$gzip_kb"

  # The entry chunk is the index JS file (not a vendor manualChunk).
  if [[ "$fname" == index-*.js ]]; then
    entry_file="$fname"
    entry_raw_kb=$raw_kb
  fi
done

echo ""

if [[ -z "$entry_file" ]]; then
  echo "FAIL: Could not locate entry chunk (index-*.js) in $DIST_ASSETS." >&2
  exit 1
fi

echo "Entry chunk:  $entry_file"
echo "Entry raw KB: $entry_raw_kb"
echo "Budget KB:    $ENTRY_RAW_BUDGET_KB"
echo ""

over_budget=0
if (( entry_raw_kb > ENTRY_RAW_BUDGET_KB )); then
  over_budget=1
fi

if (( EXPECT_ISSUE )); then
  if (( over_budget )); then
    echo "PASS (--expect-issue): entry chunk ${entry_raw_kb} KB exceeds budget ${ENTRY_RAW_BUDGET_KB} KB as expected."
    exit 0
  else
    echo "FAIL (--expect-issue): entry chunk ${entry_raw_kb} KB is within budget ${ENTRY_RAW_BUDGET_KB} KB — issue not reproduced." >&2
    exit 1
  fi
else
  if (( over_budget )); then
    echo "FAIL: entry chunk ${entry_raw_kb} KB exceeds budget ${ENTRY_RAW_BUDGET_KB} KB." >&2
    exit 1
  else
    echo "PASS: entry chunk ${entry_raw_kb} KB is within budget ${ENTRY_RAW_BUDGET_KB} KB."
    exit 0
  fi
fi
