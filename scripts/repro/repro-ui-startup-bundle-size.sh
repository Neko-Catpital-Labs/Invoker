#!/usr/bin/env bash
#
# Deterministic repro for the oversized @invoker/ui startup bundle.
#
# A production `pnpm --filter @invoker/ui build` currently emits a single
# entry chunk (`dist/assets/index-*.js`) of roughly 1.77 MB raw / 540 KB
# gzipped. On cold start the renderer must download (over file://, cheap),
# parse, and evaluate the entire chunk before React mounts and before
# `preload_bootstrap_sync` even gets the chance to paint. Vite already
# warns about chunks over 500 KB, but the warning is advisory only and
# easy to ignore -- nothing in the repo fails CI on a bundle regression.
#
# This script gives us an executable, budget-gated check:
#
#   * Builds @invoker/ui via the workspace script (no native deps required).
#   * Locates the entry chunk by parsing the module script tag emitted into
#     dist/index.html (so renames / hash changes do not break detection).
#   * Reports raw + gzip sizes for the entry chunk and every other JS/CSS
#     asset under packages/ui/dist/assets.
#   * Compares the entry chunk's raw size against a documented budget and
#     decides PASS/FAIL based on the mode:
#       --expect-issue  -> PASS when the entry chunk EXCEEDS the budget
#                          (baseline mode: confirms the bloat is real today).
#       (default)       -> PASS only when the entry chunk is UNDER the
#                          budget (validation mode: confirms a code-split or
#                          equivalent optimization actually shrank the entry).
#
# The budget defaults below are deliberately picked so the current bundle
# (~1.77 MB raw) clearly trips `--expect-issue` while leaving room for a
# realistic post-optimization entry (lazy-loading xterm / @xyflow / the
# YAML editor / the surfaces panel should easily land under 900 KB raw).
# Override via env if the post-fix target moves.

set -euo pipefail

EXPECT_ISSUE=0
# Documented entry-chunk budget. Override via env if the project target shifts.
ENTRY_RAW_BUDGET_BYTES="${ENTRY_RAW_BUDGET_BYTES:-900000}"   # ~879 KB
ENTRY_GZIP_BUDGET_BYTES="${ENTRY_GZIP_BUDGET_BYTES:-300000}" # ~293 KB (informational)
SKIP_BUILD="${SKIP_BUILD:-0}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue          PASS only when the @invoker/ui entry chunk EXCEEDS
                          the documented budget (baseline mode -- confirms
                          the bloat reproduces today).
  --skip-build            Reuse the existing packages/ui/dist output instead
                          of running 'pnpm --filter @invoker/ui build'.
  -h, --help              Show this help and exit.

Environment overrides:
  ENTRY_RAW_BUDGET_BYTES   Raw byte budget for the entry chunk
                           (default: ${ENTRY_RAW_BUDGET_BYTES}).
  ENTRY_GZIP_BUDGET_BYTES  Informational gzip byte budget for the entry chunk
                           (default: ${ENTRY_GZIP_BUDGET_BYTES}). Not gating.
  SKIP_BUILD               Set to 1 to skip the build (same as --skip-build).

Exit codes:
  0  PASS for the selected mode.
  1  FAIL for the selected mode (budget assertion did not hold).
  2  Setup failure (build failed, entry chunk not found, etc.).
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    --skip-build)   SKIP_BUILD=1 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UI_DIST="$REPO_ROOT/packages/ui/dist"
UI_ASSETS="$UI_DIST/assets"
UI_INDEX_HTML="$UI_DIST/index.html"

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "repro: building @invoker/ui (pnpm --filter @invoker/ui build)..."
  if ! (cd "$REPO_ROOT" && pnpm --filter @invoker/ui build); then
    echo "repro: ERROR -- pnpm --filter @invoker/ui build failed" >&2
    exit 2
  fi
else
  echo "repro: SKIP_BUILD=1 -- reusing existing $UI_DIST"
fi

if [[ ! -f "$UI_INDEX_HTML" ]]; then
  echo "repro: ERROR -- expected $UI_INDEX_HTML to exist after build" >&2
  exit 2
fi
if [[ ! -d "$UI_ASSETS" ]]; then
  echo "repro: ERROR -- expected $UI_ASSETS to exist after build" >&2
  exit 2
fi

# Identify the entry chunk by reading the module script tag emitted by Vite
# into dist/index.html. This survives content-hash changes between builds.
ENTRY_REL="$(
  python3 - "$UI_INDEX_HTML" <<'PY'
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    html = fh.read()

match = re.search(
    r'<script[^>]*type=["\']module["\'][^>]*src=["\']([^"\']+)["\']',
    html,
)
if not match:
    print("", end="")
    sys.exit(0)
print(match.group(1), end="")
PY
)"

if [[ -z "$ENTRY_REL" ]]; then
  echo "repro: ERROR -- could not locate <script type=\"module\" src=...> in $UI_INDEX_HTML" >&2
  exit 2
fi

# Strip a leading ./ if present, then join against UI_DIST.
ENTRY_REL="${ENTRY_REL#./}"
ENTRY_PATH="$UI_DIST/$ENTRY_REL"
if [[ ! -f "$ENTRY_PATH" ]]; then
  echo "repro: ERROR -- entry chunk referenced in index.html not found: $ENTRY_PATH" >&2
  exit 2
fi

# Portable raw-size reader (BSD stat on macOS, GNU stat on Linux).
file_size_bytes() {
  local path="$1"
  if stat -f '%z' "$path" >/dev/null 2>&1; then
    stat -f '%z' "$path"
  else
    stat -c '%s' "$path"
  fi
}

# gzip -c | wc -c is the same compression the Vite build log uses for its
# "gzip:" column, which keeps this script's numbers and the build log in sync.
file_gzip_bytes() {
  local path="$1"
  gzip -c -- "$path" | wc -c | tr -d ' '
}

humanize() {
  # Print bytes as "B / KB / MB" with two decimals for the latter two.
  python3 - "$1" <<'PY'
import sys
n = int(sys.argv[1])
if n < 1024:
    print(f"{n} B")
elif n < 1024 * 1024:
    print(f"{n / 1024:.2f} KB")
else:
    print(f"{n / (1024 * 1024):.2f} MB")
PY
}

ENTRY_RAW="$(file_size_bytes "$ENTRY_PATH")"
ENTRY_GZIP="$(file_gzip_bytes "$ENTRY_PATH")"

echo ""
echo "repro-bundle-report:"
echo "  ui dist root:        $UI_DIST"
echo "  entry chunk path:    $ENTRY_REL"
echo "  entry chunk raw:     $(humanize "$ENTRY_RAW") ($ENTRY_RAW bytes)"
echo "  entry chunk gzip:    $(humanize "$ENTRY_GZIP") ($ENTRY_GZIP bytes)"
echo "  raw budget:          $(humanize "$ENTRY_RAW_BUDGET_BYTES") ($ENTRY_RAW_BUDGET_BYTES bytes)"
echo "  gzip budget (info):  $(humanize "$ENTRY_GZIP_BUDGET_BYTES") ($ENTRY_GZIP_BUDGET_BYTES bytes)"
echo ""
echo "  all assets (sorted by raw size, largest first):"

# Enumerate every JS/CSS asset under dist/assets, mark the entry chunk, and
# print raw + gzip sizes. Sort largest-first so the offender is obvious.
ENTRY_BASENAME="$(basename "$ENTRY_PATH")"
declare -a ASSET_ROWS=()
while IFS= read -r -d '' asset; do
  raw="$(file_size_bytes "$asset")"
  gz="$(file_gzip_bytes "$asset")"
  base="$(basename "$asset")"
  marker="     "
  if [[ "$base" == "$ENTRY_BASENAME" ]]; then
    marker="ENTRY"
  fi
  ASSET_ROWS+=("$raw|$gz|$marker|$base")
done < <(find "$UI_ASSETS" -maxdepth 1 -type f \( -name '*.js' -o -name '*.css' \) -print0)

if (( ${#ASSET_ROWS[@]} == 0 )); then
  echo "    (no .js / .css assets found under $UI_ASSETS)"
else
  printf '%s\n' "${ASSET_ROWS[@]}" | sort -t '|' -k1,1 -n -r | while IFS='|' read -r raw gz marker base; do
    printf '    [%s] %-40s raw=%-12s gzip=%-12s\n' \
      "$marker" "$base" "$(humanize "$raw")" "$(humanize "$gz")"
  done
fi
echo ""

# Budget assertion.
exceeded=0
if (( ENTRY_RAW > ENTRY_RAW_BUDGET_BYTES )); then
  exceeded=1
fi

if (( EXPECT_ISSUE == 1 )); then
  if (( exceeded == 1 )); then
    echo "repro: PASS (--expect-issue) -- entry chunk raw size $(humanize "$ENTRY_RAW")" \
         "exceeds budget $(humanize "$ENTRY_RAW_BUDGET_BYTES"); bloat reproduces."
    exit 0
  fi
  echo "repro: FAIL (--expect-issue) -- entry chunk raw size $(humanize "$ENTRY_RAW")" \
       "is at/under budget $(humanize "$ENTRY_RAW_BUDGET_BYTES");" \
       "the bloat appears already fixed, so this baseline mode no longer applies." >&2
  exit 1
fi

if (( exceeded == 1 )); then
  echo "repro: FAIL -- entry chunk raw size $(humanize "$ENTRY_RAW")" \
       "exceeds budget $(humanize "$ENTRY_RAW_BUDGET_BYTES")." \
       "Code-split the startup bundle (lazy-load xterm / @xyflow / heavy panels)" \
       "until the entry chunk lands under the budget." >&2
  exit 1
fi

echo "repro: PASS -- entry chunk raw size $(humanize "$ENTRY_RAW")" \
     "is within budget $(humanize "$ENTRY_RAW_BUDGET_BYTES")."
exit 0
