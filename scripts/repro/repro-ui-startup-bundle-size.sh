#!/usr/bin/env bash
set -euo pipefail

# Repro for UI startup bundle size.
#
# Motivation: a large entry chunk (loaded synchronously on cold start) forces
# the renderer to parse and evaluate a lot of JS before the first frame, which
# is a plausible cold-start risk independent of graph layout. Vite emits a
# warning when chunks exceed 500 KiB, but the warning text is easy to ignore
# and not enforceable in CI. This script makes the budget explicit.
#
# Documented budget: entry chunk must be <= 800 KiB raw (819200 bytes).
# Current state (pre-fix): entry chunk is ~1.77 MiB raw — exceeds budget.
#
# Usage:
#   scripts/repro/repro-ui-startup-bundle-size.sh
#       Post-fix verification. Exits 0 ONLY when the entry chunk is
#       at or under the documented budget.
#
#   scripts/repro/repro-ui-startup-bundle-size.sh --expect-issue
#       Pre-fix reproduction. Exits 0 when the entry chunk EXCEEDS the
#       documented budget (i.e. the issue is reproduced). Exits 1 when
#       the entry chunk is within budget (issue cannot be reproduced).
#
# Env vars:
#   ENTRY_BUDGET_BYTES   Override the raw-byte budget for the entry chunk.
#                        Default: 819200 (800 KiB).
#   SKIP_BUILD=1         Skip `pnpm --filter @invoker/ui build` and inspect
#                        whatever is already in packages/ui/dist/assets.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENTRY_BUDGET_BYTES="${ENTRY_BUDGET_BYTES:-819200}"
SKIP_BUILD="${SKIP_BUILD:-0}"
EXPECT_ISSUE=0

for arg in "$@"; do
  case "$arg" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help)
      sed -n '3,29p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

cd "$ROOT_DIR"

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "==> Building @invoker/ui"
  pnpm --filter @invoker/ui build
else
  echo "==> SKIP_BUILD=1; reusing existing packages/ui/dist"
fi

ASSETS_DIR="packages/ui/dist/assets"
INDEX_HTML="packages/ui/dist/index.html"

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "FAIL: $ASSETS_DIR not found after build." >&2
  exit 2
fi

if [[ ! -f "$INDEX_HTML" ]]; then
  echo "FAIL: $INDEX_HTML not found after build." >&2
  exit 2
fi

# Identify the entry chunk from the built index.html. Vite emits a single
# <script type="module" src="...assets/index-<hash>.js"> tag for the entry.
ENTRY_REL="$(grep -oE 'src="[^"]*assets/[^"]+\.js"' "$INDEX_HTML" \
  | head -n1 \
  | sed -E 's#.*assets/([^"]+)".*#\1#')"

if [[ -z "$ENTRY_REL" ]]; then
  echo "FAIL: could not identify entry chunk script tag in $INDEX_HTML" >&2
  exit 2
fi

ENTRY_PATH="$ASSETS_DIR/$ENTRY_REL"
if [[ ! -f "$ENTRY_PATH" ]]; then
  echo "FAIL: entry chunk $ENTRY_PATH does not exist" >&2
  exit 2
fi

human() {
  awk -v b="$1" 'BEGIN {
    if (b >= 1048576) printf "%.2f MiB", b/1048576;
    else if (b >= 1024) printf "%.2f KiB", b/1024;
    else printf "%d B", b;
  }'
}

gzsize() {
  gzip -c -9 "$1" | wc -c | tr -d ' '
}

TMPLIST="$(mktemp)"
trap 'rm -f "$TMPLIST"' EXIT

while IFS= read -r file; do
  raw="$(wc -c < "$file" | tr -d ' ')"
  gz="$(gzsize "$file")"
  printf "%d\t%d\t%s\n" "$raw" "$gz" "$(basename "$file")" >> "$TMPLIST"
done < <(find "$ASSETS_DIR" -maxdepth 1 -type f \( -name '*.js' -o -name '*.css' \))

echo
echo "==> Bundle assets in $ASSETS_DIR (sorted by raw size, desc)"
printf "%-12s %-12s %s\n" "raw" "gzip" "file"
printf "%-12s %-12s %s\n" "-----------" "-----------" "----"
sort -k1,1 -nr "$TMPLIST" | while IFS=$'\t' read -r raw gz name; do
  marker=""
  if [[ "$name" == "$ENTRY_REL" ]]; then
    marker="  <-- entry"
  fi
  printf "%-12s %-12s %s%s\n" "$(human "$raw")" "$(human "$gz")" "$name" "$marker"
done

ENTRY_RAW="$(wc -c < "$ENTRY_PATH" | tr -d ' ')"
ENTRY_GZ="$(gzsize "$ENTRY_PATH")"

echo
echo "==> Entry chunk: $ENTRY_REL"
echo "    raw  = $ENTRY_RAW bytes ($(human "$ENTRY_RAW"))"
echo "    gzip = $ENTRY_GZ bytes ($(human "$ENTRY_GZ"))"
echo "==> Budget (raw): $ENTRY_BUDGET_BYTES bytes ($(human "$ENTRY_BUDGET_BYTES"))"

if (( ENTRY_RAW > ENTRY_BUDGET_BYTES )); then
  OVER=$((ENTRY_RAW - ENTRY_BUDGET_BYTES))
  echo "==> Result: OVER budget by $(human "$OVER")"
  OVER_BUDGET=1
else
  UNDER=$((ENTRY_BUDGET_BYTES - ENTRY_RAW))
  echo "==> Result: UNDER budget by $(human "$UNDER")"
  OVER_BUDGET=0
fi

echo
if (( EXPECT_ISSUE == 1 )); then
  if (( OVER_BUDGET == 1 )); then
    echo "PASS (--expect-issue): entry chunk exceeds budget — issue reproduced."
    exit 0
  fi
  echo "FAIL (--expect-issue): entry chunk is within budget — cannot reproduce." >&2
  exit 1
fi

if (( OVER_BUDGET == 0 )); then
  echo "PASS: entry chunk is within budget."
  exit 0
fi
echo "FAIL: entry chunk exceeds budget." >&2
exit 1
