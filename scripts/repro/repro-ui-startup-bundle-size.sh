#!/usr/bin/env bash
# Repro: production UI bundle has a heavy entry chunk that bloats cold-start
# parse/evaluation cost. The current production build emits an entry chunk of
# roughly 1.77MB raw (well above Vite's 500KB warning), which is a plausible
# cold-start risk independent of graph layout.
#
# This script is deterministic: it rebuilds the UI from source, inspects
# `packages/ui/dist/assets`, prints raw and gzip sizes for the entry chunk and
# every emitted JS chunk, and enforces explicit budgets documented below.
#
# Budgets (documented; tune in this script when the fix lands):
#   ENTRY_RAW_BUDGET_BYTES   -- 600000 bytes (~586 KiB) for the entry chunk raw
#   ENTRY_GZIP_BUDGET_BYTES  -- 200000 bytes (~195 KiB) for the entry chunk gzip
#
# Modes:
#   (default)        exit 0 only when the entry chunk is <= both budgets.
#                    Use this after the optimization to guard against regression.
#   --expect-issue   exit 0 when the entry chunk exceeds either budget.
#                    Use this before the fix to demonstrate the current bloat.
set -euo pipefail

EXPECT_ISSUE=0
if [[ "${1:-}" == "--expect-issue" ]]; then
  EXPECT_ISSUE=1
  shift
fi
if [[ $# -ne 0 ]]; then
  echo "usage: $0 [--expect-issue]" >&2
  exit 2
fi

ENTRY_RAW_BUDGET_BYTES="${ENTRY_RAW_BUDGET_BYTES:-600000}"
ENTRY_GZIP_BUDGET_BYTES="${ENTRY_GZIP_BUDGET_BYTES:-200000}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSETS_DIR="$ROOT_DIR/packages/ui/dist/assets"

cd "$ROOT_DIR"

echo "==> Building @invoker/ui (production)"
pnpm --filter @invoker/ui build >/dev/null

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "repro: expected build output at $ASSETS_DIR" >&2
  exit 1
fi

# Vite emits the SPA entry as `index-<hash>.js`. Pick the largest matching
# file so a stale hashed leftover from a previous build never wins over a
# fresh one (the build runs with emptyOutDir: true, but be defensive).
shopt -s nullglob
ENTRY_CANDIDATES=("$ASSETS_DIR"/index-*.js)
shopt -u nullglob
if [[ ${#ENTRY_CANDIDATES[@]} -eq 0 ]]; then
  echo "repro: no index-*.js entry chunk found under $ASSETS_DIR" >&2
  ls -la "$ASSETS_DIR" >&2 || true
  exit 1
fi

ENTRY_FILE=""
ENTRY_RAW=0
for candidate in "${ENTRY_CANDIDATES[@]}"; do
  size=$(wc -c <"$candidate")
  if (( size > ENTRY_RAW )); then
    ENTRY_RAW=$size
    ENTRY_FILE="$candidate"
  fi
done

raw_size() { wc -c <"$1" | tr -d ' '; }
gzip_size() { gzip -c -- "$1" | wc -c | tr -d ' '; }

human() {
  # Best-effort human-readable byte count. Falls back to raw bytes when
  # `numfmt` is unavailable (e.g. on macOS without coreutils).
  if command -v numfmt >/dev/null 2>&1; then
    numfmt --to=iec --suffix=B --format="%.2f" "$1"
  else
    printf '%sB' "$1"
  fi
}

print_row() {
  local label="$1" raw="$2" gz="$3"
  printf '  %-48s raw=%10s bytes (%s)  gzip=%10s bytes (%s)\n' \
    "$label" "$raw" "$(human "$raw")" "$gz" "$(human "$gz")"
}

ENTRY_GZIP=$(gzip_size "$ENTRY_FILE")

echo
echo "==> UI bundle chunks under $ASSETS_DIR"
# Print every JS chunk so reviewers can see the full breakdown, sorted by
# raw size descending. The entry chunk is also re-printed below with a label.
TMP_LIST=$(mktemp)
trap 'rm -f "$TMP_LIST"' EXIT
shopt -s nullglob
for f in "$ASSETS_DIR"/*.js; do
  r=$(raw_size "$f")
  g=$(gzip_size "$f")
  printf '%s\t%s\t%s\n' "$r" "$g" "$(basename "$f")" >>"$TMP_LIST"
done
shopt -u nullglob
sort -k1,1nr "$TMP_LIST" | while IFS=$'\t' read -r r g name; do
  print_row "$name" "$r" "$g"
done

echo
echo "==> Entry chunk"
print_row "$(basename "$ENTRY_FILE") (entry)" "$ENTRY_RAW" "$ENTRY_GZIP"

echo
echo "==> Budgets"
echo "  entry raw budget:  $ENTRY_RAW_BUDGET_BYTES bytes ($(human "$ENTRY_RAW_BUDGET_BYTES"))"
echo "  entry gzip budget: $ENTRY_GZIP_BUDGET_BYTES bytes ($(human "$ENTRY_GZIP_BUDGET_BYTES"))"

OVER_RAW=0
OVER_GZIP=0
(( ENTRY_RAW  > ENTRY_RAW_BUDGET_BYTES  )) && OVER_RAW=1
(( ENTRY_GZIP > ENTRY_GZIP_BUDGET_BYTES )) && OVER_GZIP=1

if [[ "$EXPECT_ISSUE" -eq 1 ]]; then
  if (( OVER_RAW == 1 || OVER_GZIP == 1 )); then
    echo
    echo "ui-startup-bundle-size issue reproduced:"
    (( OVER_RAW  == 1 )) && echo "  entry raw  $ENTRY_RAW  > budget $ENTRY_RAW_BUDGET_BYTES"
    (( OVER_GZIP == 1 )) && echo "  entry gzip $ENTRY_GZIP > budget $ENTRY_GZIP_BUDGET_BYTES"
    exit 0
  fi
  echo
  echo "repro: expected entry chunk to exceed a documented budget, but it is within both" >&2
  echo "  entry raw  $ENTRY_RAW  <= budget $ENTRY_RAW_BUDGET_BYTES" >&2
  echo "  entry gzip $ENTRY_GZIP <= budget $ENTRY_GZIP_BUDGET_BYTES" >&2
  exit 1
fi

if (( OVER_RAW == 1 || OVER_GZIP == 1 )); then
  echo
  echo "repro: UI entry chunk exceeds documented budget" >&2
  (( OVER_RAW  == 1 )) && echo "  entry raw  $ENTRY_RAW  > budget $ENTRY_RAW_BUDGET_BYTES"  >&2
  (( OVER_GZIP == 1 )) && echo "  entry gzip $ENTRY_GZIP > budget $ENTRY_GZIP_BUDGET_BYTES" >&2
  exit 1
fi

echo
echo "ui-startup-bundle-size fixed: entry chunk within budget"
echo "  entry raw  $ENTRY_RAW  <= budget $ENTRY_RAW_BUDGET_BYTES"
echo "  entry gzip $ENTRY_GZIP <= budget $ENTRY_GZIP_BUDGET_BYTES"
