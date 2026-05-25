#!/usr/bin/env bash
#
# Deterministic repro for the oversized @invoker/ui entry chunk.
#
# The production UI build currently emits a single ~1.77MB entry chunk
# (`packages/ui/dist/assets/index-*.js`), which the renderer must parse
# and evaluate during cold start before the workflow graph paints.
# Vite's bundle-warning text mentions this in passing, but the warning
# is informational only -- it does not fail the build, does not pin a
# numeric budget, and is easy to miss in CI noise.
#
# This script makes the size budget explicit and machine-checkable:
#
#   1. Run `pnpm --filter @invoker/ui build` to produce dist/assets.
#   2. Print raw and gzip sizes for the entry chunk and every other
#      JS chunk under dist/assets so regressions are visible at a
#      glance.
#   3. Compare the entry chunk against a documented budget and exit
#      pass/fail.
#
# Modes:
#   --expect-issue   PASS (exit 0) when the entry chunk is OVER budget.
#                    Confirms the bug exists today (baseline mode).
#   (default)        PASS (exit 0) only when the entry chunk is UNDER
#                    budget. Validates the optimization landed.
#
# The budgets below are deliberately tighter than the current observed
# sizes so that any future regression toward today's baseline trips
# the default mode.

set -euo pipefail

# Documented budgets for the entry chunk (`dist/assets/index-*.js`).
# Current baseline is ~1.77MB raw / ~540KB gzip; the post-fix target
# leaves headroom for normal feature work without re-introducing the
# original cold-start parse cost.
ENTRY_RAW_BUDGET_BYTES="${ENTRY_RAW_BUDGET_BYTES:-1200000}"      # 1.20 MB
ENTRY_GZIP_BUDGET_BYTES="${ENTRY_GZIP_BUDGET_BYTES:-400000}"     # 400 KB

EXPECT_ISSUE=0
SKIP_BUILD=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue              PASS only if the entry chunk EXCEEDS the documented
                              budget (baseline mode that confirms the bug exists).
  --skip-build                Reuse the existing packages/ui/dist output instead
                              of rebuilding. Fails if dist/assets is missing.
  --entry-raw-budget BYTES    Override raw-byte budget for the entry chunk
                              (default: ${ENTRY_RAW_BUDGET_BYTES}).
  --entry-gzip-budget BYTES   Override gzip-byte budget for the entry chunk
                              (default: ${ENTRY_GZIP_BUDGET_BYTES}).
  -h, --help                  Show this help.

Environment:
  ENTRY_RAW_BUDGET_BYTES, ENTRY_GZIP_BUDGET_BYTES -- same as the flags.
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue)             EXPECT_ISSUE=1 ;;
    --skip-build)               SKIP_BUILD=1 ;;
    --entry-raw-budget)         shift; ENTRY_RAW_BUDGET_BYTES="$1" ;;
    --entry-raw-budget=*)       ENTRY_RAW_BUDGET_BYTES="${1#*=}" ;;
    --entry-gzip-budget)        shift; ENTRY_GZIP_BUDGET_BYTES="$1" ;;
    --entry-gzip-budget=*)      ENTRY_GZIP_BUDGET_BYTES="${1#*=}" ;;
    -h|--help)                  usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UI_DIST_DIR="$REPO_ROOT/packages/ui/dist"
UI_ASSETS_DIR="$UI_DIST_DIR/assets"

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "repro: building @invoker/ui (pnpm --filter @invoker/ui build)..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/ui build >/dev/null)
fi

if [[ ! -d "$UI_ASSETS_DIR" ]]; then
  echo "repro: FAIL -- $UI_ASSETS_DIR is missing (build did not produce assets)" >&2
  exit 1
fi

# Portable byte-size helper. `wc -c < file` returns just the integer
# byte count on both macOS and Linux without trailing filename noise.
file_bytes() {
  wc -c < "$1" | tr -d ' \n'
}

# Match Vite's report: default zlib level (6), no embedded name/time
# so the result is deterministic across runs.
gzip_bytes() {
  gzip -6 -n -c "$1" | wc -c | tr -d ' \n'
}

# Locate the entry chunk. Vite emits it as `index-<hash>.js`; there
# should be exactly one.
shopt -s nullglob
ENTRY_CANDIDATES=( "$UI_ASSETS_DIR"/index-*.js )
shopt -u nullglob

if (( ${#ENTRY_CANDIDATES[@]} == 0 )); then
  echo "repro: FAIL -- no entry chunk (index-*.js) found in $UI_ASSETS_DIR" >&2
  exit 1
fi
if (( ${#ENTRY_CANDIDATES[@]} > 1 )); then
  echo "repro: FAIL -- expected exactly one index-*.js entry chunk, found ${#ENTRY_CANDIDATES[@]}:" >&2
  printf '  %s\n' "${ENTRY_CANDIDATES[@]}" >&2
  exit 1
fi
ENTRY_CHUNK="${ENTRY_CANDIDATES[0]}"

ENTRY_RAW_BYTES="$(file_bytes "$ENTRY_CHUNK")"
ENTRY_GZIP_BYTES="$(gzip_bytes "$ENTRY_CHUNK")"

echo "repro: budgets -- entry raw <= ${ENTRY_RAW_BUDGET_BYTES} bytes, entry gzip <= ${ENTRY_GZIP_BUDGET_BYTES} bytes"
echo "repro: dist/assets chunk sizes (raw / gzip):"
printf '  %-40s %12s %12s\n' "file" "raw_bytes" "gzip_bytes"
printf '  %-40s %12s %12s\n' "----" "---------" "----------"

# Print the entry chunk first, then every other .js chunk sorted by
# raw size descending so the largest secondary chunks are immediately
# visible.
ENTRY_BASENAME="$(basename "$ENTRY_CHUNK")"
printf '  %-40s %12s %12s  <-- entry\n' \
  "$ENTRY_BASENAME" "$ENTRY_RAW_BYTES" "$ENTRY_GZIP_BYTES"

shopt -s nullglob
OTHER_CHUNKS=()
for f in "$UI_ASSETS_DIR"/*.js; do
  [[ "$f" == "$ENTRY_CHUNK" ]] && continue
  OTHER_CHUNKS+=( "$f" )
done
shopt -u nullglob

if (( ${#OTHER_CHUNKS[@]} > 0 )); then
  # Build "raw\tpath" lines, sort numerically descending, then print.
  while IFS=$'\t' read -r raw path; do
    [[ -z "$path" ]] && continue
    gzip_size="$(gzip_bytes "$path")"
    printf '  %-40s %12s %12s\n' "$(basename "$path")" "$raw" "$gzip_size"
  done < <(
    for f in "${OTHER_CHUNKS[@]}"; do
      printf '%s\t%s\n' "$(file_bytes "$f")" "$f"
    done | sort -rn -k1,1
  )
fi

echo ""
echo "repro-summary:"
echo "  entry_chunk: $ENTRY_BASENAME"
echo "  entry_raw_bytes: $ENTRY_RAW_BYTES (budget: $ENTRY_RAW_BUDGET_BYTES)"
echo "  entry_gzip_bytes: $ENTRY_GZIP_BYTES (budget: $ENTRY_GZIP_BUDGET_BYTES)"

over_raw=0
over_gzip=0
if (( ENTRY_RAW_BYTES > ENTRY_RAW_BUDGET_BYTES )); then over_raw=1; fi
if (( ENTRY_GZIP_BYTES > ENTRY_GZIP_BUDGET_BYTES )); then over_gzip=1; fi
over_budget=0
if (( over_raw == 1 || over_gzip == 1 )); then over_budget=1; fi

if (( EXPECT_ISSUE == 1 )); then
  if (( over_budget == 1 )); then
    echo "repro: PASS (--expect-issue) -- entry chunk exceeds budget (raw_over=$over_raw, gzip_over=$over_gzip)"
    exit 0
  fi
  echo "repro: FAIL (--expect-issue) -- entry chunk is within budget; the bug appears to be already fixed" >&2
  exit 1
fi

if (( over_budget == 1 )); then
  echo "repro: FAIL -- entry chunk exceeds budget (raw_over=$over_raw, gzip_over=$over_gzip)" >&2
  exit 1
fi

echo "repro: PASS -- entry chunk is within budget"
exit 0
