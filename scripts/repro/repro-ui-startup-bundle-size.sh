#!/usr/bin/env bash
#
# Deterministic repro for the oversized @invoker/ui entry chunk.
#
# The renderer's production build currently ships a single ~1.77MB
# entry chunk (gzip ~540KB). That much script parsed and evaluated on
# cold launch is a plausible contributor to startup latency — separate
# from the workflow-graph layout cost. Vite already prints a 500KB
# warning, but the warning is only advisory and is trivially silenced
# by raising `chunkSizeWarningLimit`; the repro below makes the budget
# explicit, repo-local, and enforced.
#
# What it does:
#   1. Builds @invoker/ui via pnpm.
#   2. Resolves the entry chunk by reading the <script type="module">
#      tag in dist/index.html (so a renamed/restructured entry still
#      gets caught instead of relying on filename heuristics).
#   3. Prints raw + gzip sizes for the entry chunk, every other major
#      JS chunk (>=1KB) in dist/assets, and the CSS asset(s).
#   4. Compares the entry chunk's raw size against ENTRY_BUDGET_BYTES.
#
# Modes:
#   --expect-issue   PASS (exit 0) when the entry chunk EXCEEDS the
#                    documented budget — confirms the regression exists
#                    today.
#   (default)        PASS (exit 0) only when the entry chunk is UNDER
#                    the documented budget — validates the optimization
#                    after the fix lands.
#
# Tunables (env vars; flag forms below):
#   ENTRY_BUDGET_BYTES   Raw byte budget for the entry chunk.
#                        Default: 1_500_000 (~1.43MB). The current
#                        baseline (~1.77MB) is over this; a reasonable
#                        post-optimization build (code split / lazy
#                        loaded xterm + @xyflow/react / dropped dead
#                        deps) should comfortably land below.
#   SKIP_BUILD=1         Reuse an existing packages/ui/dist instead of
#                        rebuilding (useful for iterating on budgets).

set -euo pipefail

EXPECT_ISSUE=0
ENTRY_BUDGET_BYTES="${ENTRY_BUDGET_BYTES:-1500000}"
SKIP_BUILD="${SKIP_BUILD:-0}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue                 PASS only if the entry chunk EXCEEDS
                                 ENTRY_BUDGET_BYTES (baseline mode).
  --skip-build                   Reuse the existing packages/ui/dist
                                 output instead of rebuilding.
  --entry-budget-bytes N         Raw byte budget for the entry chunk
                                 (default: ${ENTRY_BUDGET_BYTES}).
  -h, --help                     Show this help.
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue)               EXPECT_ISSUE=1 ;;
    --skip-build)                 SKIP_BUILD=1 ;;
    --entry-budget-bytes)         shift; ENTRY_BUDGET_BYTES="$1" ;;
    --entry-budget-bytes=*)       ENTRY_BUDGET_BYTES="${1#*=}" ;;
    -h|--help)                    usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UI_DIR="$REPO_ROOT/packages/ui"
DIST_DIR="$UI_DIR/dist"
ASSETS_DIR="$DIST_DIR/assets"
INDEX_HTML="$DIST_DIR/index.html"

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "repro: building @invoker/ui..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/ui build >/dev/null)
fi

if [[ ! -f "$INDEX_HTML" ]]; then
  echo "repro: missing $INDEX_HTML after build" >&2
  exit 1
fi
if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "repro: missing $ASSETS_DIR after build" >&2
  exit 1
fi

# Resolve the entry chunk from the index.html's module script tag so
# we follow whatever name Vite picked. Strip a leading "./" if present.
ENTRY_REL="$(python3 - "$INDEX_HTML" <<'PY'
import re
import sys

html = open(sys.argv[1], "r", encoding="utf-8").read()
matches = re.findall(
    r'<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"',
    html,
)
if not matches:
    sys.exit(0)
src = matches[-1]
if src.startswith("./"):
    src = src[2:]
sys.stdout.write(src)
PY
)"
if [[ -z "$ENTRY_REL" ]]; then
  echo "repro: could not find <script type=\"module\"> tag in $INDEX_HTML" >&2
  exit 1
fi
ENTRY_PATH="$DIST_DIR/$ENTRY_REL"
if [[ ! -f "$ENTRY_PATH" ]]; then
  echo "repro: entry chunk $ENTRY_PATH (from index.html) not found on disk" >&2
  exit 1
fi

raw_bytes() {
  wc -c < "$1" | tr -d ' \n\r\t'
}
gzip_bytes() {
  gzip -c "$1" | wc -c | tr -d ' \n\r\t'
}
fmt_kb() {
  python3 -c "import sys; print(f'{int(sys.argv[1])/1024:.2f} kB')" "$1"
}

print_row() {
  local label="$1" path="$2"
  local raw gz
  raw="$(raw_bytes "$path")"
  gz="$(gzip_bytes "$path")"
  printf '  %-7s %-34s raw=%-12s gzip=%s\n' \
    "$label" "$(basename "$path")" "$(fmt_kb "$raw")" "$(fmt_kb "$gz")"
}

echo "repro-summary: @invoker/ui bundle sizes (dist/assets)"
print_row "entry" "$ENTRY_PATH"

shopt -s nullglob
for chunk in "$ASSETS_DIR"/*.js; do
  if [[ "$chunk" == "$ENTRY_PATH" ]]; then
    continue
  fi
  raw="$(raw_bytes "$chunk")"
  # Vite emits 1-byte placeholders for manualChunks that ended up
  # empty; skip them so the printout stays focused on real chunks.
  if (( raw < 1024 )); then
    continue
  fi
  print_row "chunk" "$chunk"
done
for css in "$ASSETS_DIR"/*.css; do
  print_row "css" "$css"
done
shopt -u nullglob

ENTRY_RAW="$(raw_bytes "$ENTRY_PATH")"
ENTRY_GZIP="$(gzip_bytes "$ENTRY_PATH")"

echo "budget:"
echo "  ENTRY_BUDGET_BYTES=${ENTRY_BUDGET_BYTES} ($(fmt_kb "$ENTRY_BUDGET_BYTES")) -- raw, post-minification"

over_budget=0
if (( ENTRY_RAW > ENTRY_BUDGET_BYTES )); then
  over_budget=1
fi

echo "entry-vs-budget: raw=${ENTRY_RAW} gzip=${ENTRY_GZIP} over_budget=${over_budget}"

if [[ "$EXPECT_ISSUE" == "1" ]]; then
  if (( over_budget == 1 )); then
    echo "repro: PASS (--expect-issue) -- entry chunk (${ENTRY_RAW} B) exceeds budget (${ENTRY_BUDGET_BYTES} B)"
    exit 0
  fi
  echo "repro: FAIL (--expect-issue) -- entry chunk (${ENTRY_RAW} B) is already under budget (${ENTRY_BUDGET_BYTES} B); the regression appears to be fixed" >&2
  exit 1
fi

if (( over_budget == 1 )); then
  echo "repro: FAIL -- entry chunk (${ENTRY_RAW} B) exceeds budget (${ENTRY_BUDGET_BYTES} B)" >&2
  exit 1
fi
echo "repro: PASS -- entry chunk (${ENTRY_RAW} B) is under budget (${ENTRY_BUDGET_BYTES} B)"
exit 0
