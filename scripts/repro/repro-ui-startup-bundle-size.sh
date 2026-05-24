#!/usr/bin/env bash
#
# Deterministic repro for the @invoker/ui startup bundle size.
#
# The production renderer build today ships a single ~1.77MB entry chunk
# (dist/assets/index-*.js) referenced directly from dist/index.html.
# That chunk is parsed and evaluated on every cold start before any
# workflow graph layout work begins, so it is a plausible cold-start
# parse/evaluation cost that Vite's "chunks larger than 500 kB" warning
# only hints at -- it does not gate CI and it has no explicit budget.
#
# This script:
#   1. Builds @invoker/ui (production Vite build).
#   2. Locates the entry JS chunk via packages/ui/dist/index.html
#      (the file referenced from `<script type="module" src=...>`).
#   3. Reports raw and gzip sizes for the entry chunk and for every
#      JS/CSS asset in packages/ui/dist/assets.
#   4. Compares the entry chunk raw size against an explicit budget
#      that is documented in this file (ENTRY_RAW_BUDGET_BYTES).
#
# Modes:
#   --expect-issue   Baseline mode. PASS (exit 0) only when the entry
#                    chunk RAW size EXCEEDS ENTRY_RAW_BUDGET_BYTES.
#                    Use this before the optimization to confirm the
#                    bundle-size issue exists today.
#   (default)        Fix-validation mode. PASS (exit 0) only when the
#                    entry chunk RAW size is BELOW ENTRY_RAW_BUDGET_BYTES.
#                    Use this after the optimization to lock in the win.
#
# The budget is intentionally chosen well below today's ~1.77MB entry
# chunk so that --expect-issue passes on the current tree, and well
# above what a properly code-split renderer should produce so the
# default mode passes once the bundle is actually split.

set -euo pipefail

# ── Documented budgets ────────────────────────────────────────────
# Entry chunk RAW (uncompressed minified JS) budget in bytes.
# Today the entry chunk is ~1,773,923 bytes. A reasonable post-fix
# target is well under 1.2MB (achieved by code-splitting xyflow,
# xterm, monaco-equivalents, surface-runner blobs, etc).
ENTRY_RAW_BUDGET_BYTES="${ENTRY_RAW_BUDGET_BYTES:-1200000}"
# Entry chunk gzip budget (reported, not gated, for visibility).
ENTRY_GZIP_BUDGET_BYTES="${ENTRY_GZIP_BUDGET_BYTES:-400000}"

EXPECT_ISSUE=0
SKIP_BUILD=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue          PASS (exit 0) only when the entry chunk RAW
                          size EXCEEDS ENTRY_RAW_BUDGET_BYTES
                          (baseline / before-fix mode).
  --skip-build            Reuse an existing packages/ui/dist build
                          instead of rebuilding (faster local reruns).
  -h, --help              Show this help.

Environment overrides:
  ENTRY_RAW_BUDGET_BYTES   Entry chunk raw budget in bytes
                           (default: ${ENTRY_RAW_BUDGET_BYTES}).
  ENTRY_GZIP_BUDGET_BYTES  Entry chunk gzip budget in bytes
                           (default: ${ENTRY_GZIP_BUDGET_BYTES},
                           reported only).
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
UI_DIR="$REPO_ROOT/packages/ui"
DIST_DIR="$UI_DIR/dist"
ASSETS_DIR="$DIST_DIR/assets"
INDEX_HTML="$DIST_DIR/index.html"

if [[ "$SKIP_BUILD" = "0" ]]; then
  echo "repro: building @invoker/ui..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/ui build >/dev/null)
else
  echo "repro: --skip-build set, reusing existing $DIST_DIR"
fi

if [[ ! -f "$INDEX_HTML" ]]; then
  echo "repro: FAIL -- $INDEX_HTML not found after build" >&2
  exit 2
fi
if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "repro: FAIL -- $ASSETS_DIR not found after build" >&2
  exit 2
fi

# Parse the entry chunk path out of index.html. Vite emits exactly one
# `<script type="module" ... src="./assets/<entry>.js">` for the entry,
# which is the only chunk a fresh tab parses synchronously on cold start.
ENTRY_REL="$(
  python3 - "$INDEX_HTML" <<'PY'
import re
import sys

with open(sys.argv[1], "r", encoding="utf-8") as fh:
    html = fh.read()

matches = re.findall(
    r'<script[^>]+type="module"[^>]+src="([^"]+)"',
    html,
)
if not matches:
    print("", end="")
    sys.exit(0)
# Strip a leading "./" so we can join against dist/.
print(matches[0].lstrip("./"))
PY
)"

if [[ -z "$ENTRY_REL" ]]; then
  echo "repro: FAIL -- could not locate <script type=module> entry in $INDEX_HTML" >&2
  exit 2
fi

ENTRY_PATH="$DIST_DIR/$ENTRY_REL"
if [[ ! -f "$ENTRY_PATH" ]]; then
  echo "repro: FAIL -- entry chunk $ENTRY_PATH (from index.html) does not exist" >&2
  exit 2
fi

raw_size() {
  # `wc -c <file` is portable across macOS and Linux and matches byte
  # counts shown by stat. Trim leading whitespace from BSD wc output.
  local n
  n=$(wc -c <"$1")
  echo "${n// /}"
}

gzip_size() {
  # gzip -9 -c gives a deterministic best-compression byte count.
  gzip -9 -c "$1" | wc -c | tr -d ' '
}

human() {
  # Pretty-print a byte count without depending on `numfmt` (not on macOS by default).
  python3 - "$1" <<'PY'
import sys
n = float(sys.argv[1])
unit = "B"
for candidate in ("KB", "MB", "GB"):
    if n < 1024:
        break
    n /= 1024
    unit = candidate
if unit == "B":
    print(f"{int(n)} {unit}")
else:
    print(f"{n:.2f} {unit}")
PY
}

ENTRY_RAW="$(raw_size "$ENTRY_PATH")"
ENTRY_GZIP="$(gzip_size "$ENTRY_PATH")"

echo
echo "repro: budgets"
echo "  ENTRY_RAW_BUDGET_BYTES  = $ENTRY_RAW_BUDGET_BYTES ($(human "$ENTRY_RAW_BUDGET_BYTES"))"
echo "  ENTRY_GZIP_BUDGET_BYTES = $ENTRY_GZIP_BUDGET_BYTES ($(human "$ENTRY_GZIP_BUDGET_BYTES")) [reported only]"
echo
echo "repro: entry chunk (from index.html)"
echo "  path:  $ENTRY_REL"
echo "  raw:   $ENTRY_RAW B ($(human "$ENTRY_RAW"))"
echo "  gzip:  $ENTRY_GZIP B ($(human "$ENTRY_GZIP"))"
echo
echo "repro: all dist/assets chunks (raw / gzip)"
printf '  %-40s %14s %14s\n' "file" "raw (B)" "gzip (B)"
printf '  %-40s %14s %14s\n' "----" "-------" "--------"

# Sort assets by raw size descending so the biggest chunks come first.
while IFS= read -r -d '' f; do
  rel="${f#"$ASSETS_DIR/"}"
  raw="$(raw_size "$f")"
  gz="$(gzip_size "$f")"
  printf '%s\t%s\t%s\n' "$raw" "$gz" "$rel"
done < <(find "$ASSETS_DIR" -maxdepth 1 -type f \( -name '*.js' -o -name '*.css' \) -print0) \
  | sort -rn \
  | while IFS=$'\t' read -r raw gz rel; do
      printf '  %-40s %14s %14s\n' "$rel" "$raw" "$gz"
    done

echo
if (( ENTRY_RAW > ENTRY_RAW_BUDGET_BYTES )); then
  OVER=$(( ENTRY_RAW - ENTRY_RAW_BUDGET_BYTES ))
  echo "repro: entry chunk EXCEEDS budget by $OVER B ($(human "$OVER"))"
  STATUS="over"
else
  UNDER=$(( ENTRY_RAW_BUDGET_BYTES - ENTRY_RAW ))
  echo "repro: entry chunk UNDER budget by $UNDER B ($(human "$UNDER"))"
  STATUS="under"
fi

if [[ "$EXPECT_ISSUE" = "1" ]]; then
  if [[ "$STATUS" = "over" ]]; then
    echo "repro: PASS (--expect-issue) -- entry chunk exceeds ENTRY_RAW_BUDGET_BYTES, bundle-size issue is reproduced"
    exit 0
  fi
  echo "repro: FAIL (--expect-issue) -- entry chunk is already within budget; the bundle-size issue appears fixed" >&2
  exit 1
fi

if [[ "$STATUS" = "under" ]]; then
  echo "repro: PASS -- entry chunk is within ENTRY_RAW_BUDGET_BYTES"
  exit 0
fi
echo "repro: FAIL -- entry chunk exceeds ENTRY_RAW_BUDGET_BYTES; the bundle-size issue is not fixed" >&2
exit 1
