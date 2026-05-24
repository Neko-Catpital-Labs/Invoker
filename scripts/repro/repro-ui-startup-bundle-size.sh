#!/usr/bin/env bash
#
# Deterministic repro for the @invoker/ui production bundle size at
# cold start. The current production build emits a single entry chunk
# (~1.77 MiB raw / ~540 KiB gzip) which the renderer must parse and
# evaluate before any user-visible UI is mounted. That parse/eval cost
# is independent of the workflow-graph layout work measured by the
# other startup repros and warrants its own budget so we do not rely on
# Vite's chunk-size warning text (easy to silence, no exit code).
#
# What the script does:
#   1. Runs `pnpm --filter @invoker/ui build` from the repo root.
#   2. Reads `packages/ui/dist/index.html` to find the entry chunk that
#      the renderer actually loads (the <script type="module" ... src>).
#   3. Prints raw and gzip sizes for the entry chunk plus every major
#      JS chunk emitted in `packages/ui/dist/assets`.
#   4. Compares the entry chunk's raw size against a documented budget
#      and decides PASS/FAIL based on the chosen mode.
#
# Budget (documented, raw bytes -- parse/eval cost scales with raw):
#   ENTRY_RAW_BUDGET_BYTES = 1048576   # 1 MiB
#
# Why 1 MiB raw:
#   * Today's entry chunk is ~1.77 MiB, which is the size the repro is
#     trying to constrain.
#   * Splitting react-dom, elkjs, js-yaml, and the xterm surface off the
#     entry (the obvious optimizations) consistently lands the entry
#     comfortably under 1 MiB raw, so 1 MiB is both reachable by a
#     realistic fix and small enough that the baseline clearly violates
#     it (exceeds budget by ~720 KiB).
#
# Modes:
#   --expect-issue   PASS (exit 0) ONLY when the entry chunk EXCEEDS the
#                    budget. Use this to confirm the bug exists on the
#                    baseline before the optimization.
#   (default)        PASS (exit 0) ONLY when the entry chunk is at or
#                    UNDER the budget. Use this after the optimization
#                    to assert it actually shrinks the entry chunk.
#
# Exit codes:
#   0  PASS for the selected mode
#   1  FAIL for the selected mode (or build/inspection produced no
#      usable entry chunk)
#   2  Usage error

set -euo pipefail

ENTRY_RAW_BUDGET_BYTES=1048576   # 1 MiB -- see header for rationale.

EXPECT_ISSUE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [--expect-issue] [-h|--help]

Build @invoker/ui and check the production entry chunk against a
documented size budget (${ENTRY_RAW_BUDGET_BYTES} bytes raw).

Options:
  --expect-issue   PASS only when the entry chunk EXCEEDS the budget
                   (baseline mode -- confirms the bug exists today).
  -h, --help       Show this help.

Without --expect-issue, the script PASSes only when the entry chunk
is at or under the budget (post-optimization mode).
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UI_DIR="$REPO_ROOT/packages/ui"
DIST_DIR="$UI_DIR/dist"
ASSETS_DIR="$DIST_DIR/assets"
INDEX_HTML="$DIST_DIR/index.html"

echo "repro: building @invoker/ui (this drives the asset sizes we measure)..."
(cd "$REPO_ROOT" && pnpm --filter @invoker/ui build)

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "repro: FAIL -- build did not produce $ASSETS_DIR" >&2
  exit 1
fi
if [[ ! -f "$INDEX_HTML" ]]; then
  echo "repro: FAIL -- build did not produce $INDEX_HTML" >&2
  exit 1
fi

# Stat helpers that work on both macOS (BSD stat) and Linux (GNU stat).
file_size() {
  if stat -f%z "$1" >/dev/null 2>&1; then
    stat -f%z "$1"
  else
    stat -c%s "$1"
  fi
}

gzip_size() {
  # gzip default level (6) is close enough to Vite's reported gzip size
  # for budget purposes; the absolute number is informational, only the
  # raw size drives PASS/FAIL.
  gzip -c "$1" | wc -c | tr -d ' '
}

format_kib() {
  # Print bytes as "N.NN KiB" using awk (no bc dependency).
  awk -v b="$1" 'BEGIN { printf "%.2f KiB", b/1024 }'
}

# Find the entry chunk the renderer actually loads. dist/index.html
# contains exactly one <script type="module" ... src="./assets/...">
# and that src is the entry chunk.
ENTRY_REL="$(python3 - "$INDEX_HTML" <<'PY'
import re, sys
with open(sys.argv[1], "r", encoding="utf-8") as fh:
    html = fh.read()
matches = re.findall(
    r'<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"',
    html,
)
if not matches:
    sys.exit("no <script type=\"module\" src=...> in index.html")
if len(matches) > 1:
    sys.exit(f"expected exactly one module entry, got: {matches}")
sys.stdout.write(matches[0])
PY
)"

# index.html refers to assets via "./assets/<file>" (Vite base: './').
ENTRY_BASENAME="$(basename "$ENTRY_REL")"
ENTRY_PATH="$ASSETS_DIR/$ENTRY_BASENAME"

if [[ ! -f "$ENTRY_PATH" ]]; then
  echo "repro: FAIL -- entry chunk $ENTRY_REL referenced by index.html is missing at $ENTRY_PATH" >&2
  exit 1
fi

ENTRY_RAW_BYTES="$(file_size "$ENTRY_PATH")"
ENTRY_GZIP_BYTES="$(gzip_size "$ENTRY_PATH")"

echo
echo "repro: entry chunk (from dist/index.html):"
printf '  %-40s raw=%10d (%s)  gzip=%9d (%s)\n' \
  "$ENTRY_BASENAME" \
  "$ENTRY_RAW_BYTES" "$(format_kib "$ENTRY_RAW_BYTES")" \
  "$ENTRY_GZIP_BYTES" "$(format_kib "$ENTRY_GZIP_BYTES")"

echo
echo "repro: all JS chunks in dist/assets (sorted, largest first):"
# Sorted descending by raw byte size. Single-byte placeholder chunks
# (empty chunks emitted for manualChunks groups whose modules ended up
# elsewhere) are reported as "(empty)" so they do not look anomalous.
while IFS= read -r js_path; do
  [[ -z "$js_path" ]] && continue
  name="$(basename "$js_path")"
  raw="$(file_size "$js_path")"
  gz="$(gzip_size "$js_path")"
  marker=""
  if [[ "$name" == "$ENTRY_BASENAME" ]]; then
    marker="  <-- entry"
  fi
  if (( raw <= 4 )); then
    marker="$marker  (empty)"
  fi
  printf '  %-40s raw=%10d (%s)  gzip=%9d (%s)%s\n' \
    "$name" \
    "$raw" "$(format_kib "$raw")" \
    "$gz"  "$(format_kib "$gz")" \
    "$marker"
done < <(
  # Sort filenames in $ASSETS_DIR/*.js by size desc using a stat-fed sort.
  for f in "$ASSETS_DIR"/*.js; do
    [[ -e "$f" ]] || continue
    printf '%d\t%s\n' "$(file_size "$f")" "$f"
  done | sort -rn | cut -f2-
)

echo
echo "repro: budget"
printf '  ENTRY_RAW_BUDGET_BYTES = %d (%s)\n' \
  "$ENTRY_RAW_BUDGET_BYTES" "$(format_kib "$ENTRY_RAW_BUDGET_BYTES")"
printf '  entry raw bytes        = %d (%s)\n' \
  "$ENTRY_RAW_BYTES" "$(format_kib "$ENTRY_RAW_BYTES")"

OVER_BUDGET=0
if (( ENTRY_RAW_BYTES > ENTRY_RAW_BUDGET_BYTES )); then
  OVER_BUDGET=1
fi

echo
if (( EXPECT_ISSUE == 1 )); then
  if (( OVER_BUDGET == 1 )); then
    over=$(( ENTRY_RAW_BYTES - ENTRY_RAW_BUDGET_BYTES ))
    echo "repro: PASS (--expect-issue) -- entry chunk exceeds budget by ${over} bytes ($(format_kib "$over")); the bundle-size issue is reproduced."
    exit 0
  fi
  under=$(( ENTRY_RAW_BUDGET_BYTES - ENTRY_RAW_BYTES ))
  echo "repro: FAIL (--expect-issue) -- entry chunk is already within budget (${under} bytes / $(format_kib "$under") under); the bug appears already fixed." >&2
  exit 1
fi

if (( OVER_BUDGET == 1 )); then
  over=$(( ENTRY_RAW_BYTES - ENTRY_RAW_BUDGET_BYTES ))
  echo "repro: FAIL -- entry chunk exceeds budget by ${over} bytes ($(format_kib "$over")); the cold-start parse/eval risk has not been mitigated." >&2
  exit 1
fi

under=$(( ENTRY_RAW_BUDGET_BYTES - ENTRY_RAW_BYTES ))
echo "repro: PASS -- entry chunk is ${under} bytes ($(format_kib "$under")) under the ${ENTRY_RAW_BUDGET_BYTES}-byte budget."
exit 0
