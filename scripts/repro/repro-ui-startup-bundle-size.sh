#!/usr/bin/env bash
set -euo pipefail

# Repro: the production UI build emits a single ~1.77MB entry chunk
# (~542KB gzip). That much JavaScript has to be parsed and evaluated before the
# renderer can paint anything, which is a plausible cold-start cost that is
# independent of graph layout. Vite already prints a generic 500KB warning, but
# the warning is advisory and easy to miss in CI logs, and it does not
# distinguish the entry chunk from vendor splits. This script builds @invoker/ui
# headlessly, inspects packages/ui/dist/assets, and gates on an explicit budget
# applied to the entry chunk (raw + gzip).
#
# Modes:
#   --expect-issue  Exit 0 when the entry chunk EXCEEDS the documented budget
#                   (the current pre-optimization baseline). This is the repro
#                   form used to demonstrate the bug.
#   (no flag)       Exit 0 ONLY when the entry chunk is at or below the
#                   documented budget (the post-optimization target). This is
#                   the form used to gate the fix.
#
# Documented budgets (chosen below the current baseline so the script gates a
# real reduction; tunable via env for follow-on iterations):
#   ENTRY_RAW_BUDGET_BYTES   default 1258291  (~1.20 MiB)
#   ENTRY_GZIP_BUDGET_BYTES  default  409600  (~400 KiB)
#
# Environment overrides:
#   REPRO_SKIP_BUILD          when set to 1, skips `pnpm --filter @invoker/ui
#                             build` and uses the existing dist/ output. Useful
#                             when iterating locally.
#   ENTRY_RAW_BUDGET_BYTES    override raw-byte budget for the entry chunk.
#   ENTRY_GZIP_BUDGET_BYTES   override gzip-byte budget for the entry chunk.

usage() {
  cat >&2 <<'USAGE'
Usage: repro-ui-startup-bundle-size.sh [--expect-issue]

  --expect-issue  Exit 0 when the entry chunk exceeds the documented budget
                  (current baseline). Reproduces the bug.
  (no flag)       Exit 0 only when the entry chunk is within the documented
                  budget (post-optimization target). Gates the fix.

Environment overrides:
  REPRO_SKIP_BUILD          skip `pnpm --filter @invoker/ui build` when set to 1
  ENTRY_RAW_BUDGET_BYTES    default 1258291  (~1.20 MiB)
  ENTRY_GZIP_BUDGET_BYTES   default 409600   (~400 KiB)
USAGE
}

EXPECT_ISSUE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

ENTRY_RAW_BUDGET_BYTES="${ENTRY_RAW_BUDGET_BYTES:-1258291}"
ENTRY_GZIP_BUDGET_BYTES="${ENTRY_GZIP_BUDGET_BYTES:-409600}"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "repro: pnpm is required but not on PATH" >&2
  exit 1
fi
if ! command -v gzip >/dev/null 2>&1; then
  echo "repro: gzip is required but not on PATH" >&2
  exit 1
fi

DIST_DIR="$REPO_ROOT/packages/ui/dist"
ASSETS_DIR="$DIST_DIR/assets"

if [[ "${REPRO_SKIP_BUILD:-0}" != "1" ]]; then
  echo "repro: building @invoker/ui..."
  pnpm --filter @invoker/ui build >/dev/null
fi

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "repro: expected $ASSETS_DIR after build, but the directory is missing" >&2
  exit 2
fi

# Locate the entry chunk. Vite hashes filenames, so resolve via the manifest
# embedded in dist/index.html (the <script type="module" src="..."> tag).
INDEX_HTML="$DIST_DIR/index.html"
if [[ ! -f "$INDEX_HTML" ]]; then
  echo "repro: expected $INDEX_HTML after build, but it is missing" >&2
  exit 2
fi

ENTRY_REL="$(grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' "$INDEX_HTML" | head -n1 || true)"
if [[ -z "$ENTRY_REL" ]]; then
  echo "repro: could not locate entry chunk reference in $INDEX_HTML" >&2
  exit 2
fi
ENTRY_FILE="$DIST_DIR/$ENTRY_REL"
if [[ ! -f "$ENTRY_FILE" ]]; then
  echo "repro: entry chunk $ENTRY_FILE referenced by index.html does not exist" >&2
  exit 2
fi

raw_bytes() { wc -c <"$1" | tr -d '[:space:]'; }
gzip_bytes() { gzip -c -- "$1" | wc -c | tr -d '[:space:]'; }
human() {
  # Render bytes as e.g. "1.77 MB" / "541.93 KB" without external deps.
  awk -v b="$1" 'BEGIN {
    if (b >= 1048576) { printf "%.2f MB", b/1048576 }
    else if (b >= 1024) { printf "%.2f KB", b/1024 }
    else { printf "%d B", b }
  }'
}

ENTRY_RAW="$(raw_bytes "$ENTRY_FILE")"
ENTRY_GZIP="$(gzip_bytes "$ENTRY_FILE")"

echo
echo "repro-ui-startup-bundle-size:"
echo "  entry chunk: $ENTRY_REL"
echo "    raw:  $ENTRY_RAW bytes  ($(human "$ENTRY_RAW"))"
echo "    gzip: $ENTRY_GZIP bytes  ($(human "$ENTRY_GZIP"))"
echo "  budget:"
echo "    raw_budget:  $ENTRY_RAW_BUDGET_BYTES bytes  ($(human "$ENTRY_RAW_BUDGET_BYTES"))"
echo "    gzip_budget: $ENTRY_GZIP_BUDGET_BYTES bytes  ($(human "$ENTRY_GZIP_BUDGET_BYTES"))"

echo "  major chunks (>=50KB raw):"
# Print every JS chunk and the CSS bundle; mark the entry chunk.
found_majors=0
shopt -s nullglob
for f in "$ASSETS_DIR"/*.js "$ASSETS_DIR"/*.css; do
  size="$(raw_bytes "$f")"
  if (( size < 51200 )); then
    continue
  fi
  found_majors=1
  gz="$(gzip_bytes "$f")"
  marker=""
  if [[ "$f" == "$ENTRY_FILE" ]]; then
    marker="  [entry]"
  fi
  rel="${f#$DIST_DIR/}"
  printf '    %s\n' "$rel$marker"
  printf '      raw:  %s bytes  (%s)\n' "$size" "$(human "$size")"
  printf '      gzip: %s bytes  (%s)\n' "$gz" "$(human "$gz")"
done
shopt -u nullglob
if (( ! found_majors )); then
  echo "    (none — all chunks under 50KB raw)"
fi

over_raw=0
over_gzip=0
(( ENTRY_RAW > ENTRY_RAW_BUDGET_BYTES )) && over_raw=1
(( ENTRY_GZIP > ENTRY_GZIP_BUDGET_BYTES )) && over_gzip=1

echo
if (( over_raw )) || (( over_gzip )); then
  echo "repro: entry chunk OVER budget (raw_over=$over_raw gzip_over=$over_gzip)"
else
  echo "repro: entry chunk WITHIN budget"
fi

if (( EXPECT_ISSUE )); then
  if (( over_raw )) || (( over_gzip )); then
    echo "repro: baseline reproduced (entry chunk exceeds documented budget)"
    exit 0
  fi
  echo "repro: expected entry chunk to exceed budget but it is within budget" >&2
  exit 1
fi

if (( ! over_raw )) && (( ! over_gzip )); then
  echo "repro: optimization holds (entry chunk within documented budget)"
  exit 0
fi
echo "repro: optimization missing — entry chunk still exceeds documented budget" >&2
exit 1
