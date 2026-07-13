#!/usr/bin/env bash
# Repro: the production @invoker/ui build ships an oversized entry chunk.
#
# Motivation: the entry chunk parsed/evaluated at cold start is ~1.77 MB raw
# today. That is a plausible startup-latency risk independent of graph layout.
# Vite only prints a soft "chunks larger than 500 kB" warning, so this script
# enforces an explicit, repo-local budget that fails CI when the entry chunk
# regresses.
#
# Usage:
#   scripts/repro/repro-ui-startup-bundle-size.sh                 # verify (post-fix)
#   scripts/repro/repro-ui-startup-bundle-size.sh --expect-issue  # reproduce (pre-fix)
#
# Exit codes:
#   default mode:        0 only when the entry chunk is UNDER budget (fix landed)
#   --expect-issue mode: 0 only when the entry chunk EXCEEDS budget (bug present)
set -euo pipefail

# --- Documented budget --------------------------------------------------------
# The fix is to lazily import the heavy layout engine (elkjs) so it no longer
# rides in the entry chunk (see memory: ui-bundle-elkjs-lazy). The current entry
# chunk is ~1,773,987 bytes raw; once elkjs is split out, the entry chunk drops
# well below this budget. 1,300,000 bytes leaves margin on both sides: today's
# build clearly exceeds it, and the optimized build clearly clears it.
ENTRY_RAW_BUDGET_BYTES=1300000

EXPECT_ISSUE=0
for arg in "$@"; do
  case "$arg" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help)
      sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

UI_DIST="packages/ui/dist"
ASSETS_DIR="$UI_DIST/assets"
INDEX_HTML="$UI_DIST/index.html"

file_size() {
  # Portable byte count (macOS BSD stat vs GNU stat).
  if stat -f%z "$1" >/dev/null 2>&1; then
    stat -f%z "$1"
  else
    stat -c%s "$1"
  fi
}

gzip_size() {
  gzip -c "$1" | wc -c | tr -d ' '
}

human() {
  awk -v b="$1" 'BEGIN {
    if (b >= 1048576)      printf "%.2f MiB", b / 1048576
    else if (b >= 1024)    printf "%.2f KiB", b / 1024
    else                   printf "%d B", b
  }'
}

echo "==> Building @invoker/ui (production)"
pnpm --filter @invoker/ui build

if [ ! -f "$INDEX_HTML" ]; then
  echo "error: $INDEX_HTML not found after build" >&2
  exit 1
fi

# Resolve the entry chunk from index.html rather than a hashed filename. The
# entry is the module <script> Vite injects; its hash changes every build.
ENTRY_REL="$(grep -oE 'src="\.?/?assets/[^"]+\.js"' "$INDEX_HTML" \
  | head -1 \
  | sed -E 's/^src="\.?\/?(.*)"$/\1/')"

if [ -z "$ENTRY_REL" ]; then
  echo "error: could not locate entry chunk <script> in $INDEX_HTML" >&2
  exit 1
fi

ENTRY_FILE="$UI_DIST/$ENTRY_REL"
if [ ! -f "$ENTRY_FILE" ]; then
  echo "error: entry chunk $ENTRY_FILE referenced by index.html does not exist" >&2
  exit 1
fi

echo
echo "==> JS chunks in $ASSETS_DIR (largest first)"
printf '    %-40s %14s %14s\n' "chunk" "raw" "gzip"
# Collect "<raw-bytes>\t<path>" for every JS asset, sort by size descending,
# then print raw + gzip for each. Pure shell — no xargs length limits.
while IFS=$'\t' read -r raw f; do
  gz="$(gzip_size "$f")"
  name="$(basename "$f")"
  marker="  "
  [ "$f" = "$ENTRY_FILE" ] && marker="* "
  printf '    %s%-38s %14s %14s\n' "$marker" "$name" "$(human "$raw")" "$(human "$gz")"
done < <(
  for f in "$ASSETS_DIR"/*.js; do
    [ -f "$f" ] || continue
    printf '%s\t%s\n' "$(file_size "$f")" "$f"
  done | sort -rn
)
echo "    (* = entry chunk)"

ENTRY_RAW="$(file_size "$ENTRY_FILE")"
ENTRY_GZIP="$(gzip_size "$ENTRY_FILE")"

echo
echo "==> Entry chunk: $(basename "$ENTRY_FILE")"
echo "    raw    : $(human "$ENTRY_RAW") ($ENTRY_RAW bytes)"
echo "    gzip   : $(human "$ENTRY_GZIP") ($ENTRY_GZIP bytes)"
echo "    budget : $(human "$ENTRY_RAW_BUDGET_BYTES") ($ENTRY_RAW_BUDGET_BYTES bytes, raw)"

OVER_BUDGET=0
if [ "$ENTRY_RAW" -gt "$ENTRY_RAW_BUDGET_BYTES" ]; then
  OVER_BUDGET=1
fi

echo
if [ "$EXPECT_ISSUE" -eq 1 ]; then
  if [ "$OVER_BUDGET" -eq 1 ]; then
    echo "REPRODUCED: entry chunk exceeds budget by $(human "$((ENTRY_RAW - ENTRY_RAW_BUDGET_BYTES))")."
    exit 0
  fi
  echo "NOT REPRODUCED: entry chunk is within budget; the oversized-bundle issue is not present."
  exit 1
else
  if [ "$OVER_BUDGET" -eq 0 ]; then
    echo "PASS: entry chunk is $(human "$((ENTRY_RAW_BUDGET_BYTES - ENTRY_RAW))") under budget."
    exit 0
  fi
  echo "FAIL: entry chunk exceeds budget by $(human "$((ENTRY_RAW - ENTRY_RAW_BUDGET_BYTES))")."
  exit 1
fi
