#!/usr/bin/env bash
#
# Deterministic repro for the @invoker/ui synchronous startup bundle size.
#
# The production UI build (`pnpm --filter @invoker/ui build`) emits a single
# module entry chunk that is referenced synchronously from
# `packages/ui/dist/index.html` (the `<script type="module">` tag).
# That chunk is executed on every cold start before the renderer can do
# anything useful, so its raw byte size is a direct cap on parse/evaluation
# time on slow disks/CPUs. Today the entry chunk is ~1.77 MB raw /
# ~540 KB gzip, which is a plausible cold-start parse/evaluation risk
# separate from graph layout cost.
#
# This script:
#   1. Builds @invoker/ui (unless --skip-build).
#   2. Locates the synchronous entry chunk via dist/index.html (we do NOT
#      assume a fixed filename; Vite hashes the name).
#   3. Prints raw + gzip sizes for the entry chunk and any "major" sibling
#      chunks (>= 50 KiB raw).
#   4. Compares the entry chunk's raw size against an explicit, documented
#      budget (default: 1,200,000 bytes = ~1.14 MiB), and exits PASS/FAIL.
#
# Modes:
#   --expect-issue   PASS only when the entry chunk EXCEEDS the budget
#                    (baseline mode -- asserts the bug exists pre-fix).
#   (default)        PASS only when the entry chunk is at or under the
#                    budget (validates the optimization post-fix).
#
# The budget is deliberately tighter than today's 1.77 MB but well above a
# minimal React+xyflow shell, leaving room for the fix (dynamic import of
# heavy panels, finer manualChunks splits, dropping unused deps) without
# requiring an unrealistic rewrite.

set -euo pipefail

# Documented budget for the synchronous startup entry chunk, in raw bytes.
# Rationale: today's entry chunk is ~1,773,923 bytes; a successful fix
# should split lazy panels out of the entry and bring it under ~1.2 MB raw.
ENTRY_BUDGET_BYTES="${ENTRY_BUDGET_BYTES:-1200000}"
MAJOR_CHUNK_THRESHOLD_BYTES=$((50 * 1024))
EXPECT_ISSUE=0
SKIP_BUILD=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Builds @invoker/ui (production) and asserts that the synchronous startup
entry chunk (the <script type="module"> referenced from dist/index.html)
fits within a documented byte budget.

Options:
  --expect-issue          PASS only if the entry chunk EXCEEDS the budget
                          (baseline mode -- asserts the bug still exists).
  --skip-build            Reuse an existing packages/ui/dist (faster local
                          iteration; do not use in CI).
  --entry-budget BYTES    Override the entry chunk budget in raw bytes
                          (default: ${ENTRY_BUDGET_BYTES}).
  -h, --help              Show this help.

Environment:
  ENTRY_BUDGET_BYTES      Same as --entry-budget.
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue)        EXPECT_ISSUE=1 ;;
    --skip-build)          SKIP_BUILD=1 ;;
    --entry-budget)        shift; ENTRY_BUDGET_BYTES="$1" ;;
    --entry-budget=*)      ENTRY_BUDGET_BYTES="${1#*=}" ;;
    -h|--help)             usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_DIR="$REPO_ROOT/packages/ui/dist"
ASSETS_DIR="$DIST_DIR/assets"
INDEX_HTML="$DIST_DIR/index.html"

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "repro: building @invoker/ui (production) ..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/ui build)
fi

if [[ ! -d "$ASSETS_DIR" || ! -f "$INDEX_HTML" ]]; then
  echo "repro: expected build output not found at $DIST_DIR" >&2
  echo "       (drop --skip-build, or run 'pnpm --filter @invoker/ui build' first)" >&2
  exit 1
fi

# Locate the synchronous entry chunk by parsing dist/index.html. Vite hashes
# the filename, so we cannot hard-code "index-*.js" -- the <script type=module>
# tag is the single source of truth for what runs at cold start.
ENTRY_REL="$(
  python3 - "$INDEX_HTML" <<'PY'
import pathlib
import re
import sys

html = pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
match = re.search(
    r'<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"',
    html,
)
if match is None:
    sys.exit("could not locate <script type=\"module\"> in dist/index.html")
src = match.group(1).lstrip("./")
print(src)
PY
)"

ENTRY_PATH="$DIST_DIR/$ENTRY_REL"
if [[ ! -f "$ENTRY_PATH" ]]; then
  echo "repro: entry chunk '$ENTRY_REL' referenced from index.html is missing on disk" >&2
  exit 1
fi

raw_size() { wc -c <"$1" | tr -d '[:space:]'; }
gzip_size() { gzip -c -9 -- "$1" | wc -c | tr -d '[:space:]'; }

format_size() {
  python3 -c '
import sys
b = int(sys.argv[1])
print(f"{b/1024:.2f} KiB ({b} bytes)")
' "$1"
}

print_chunk() {
  local label="$1" path="$2"
  local raw gz
  raw="$(raw_size "$path")"
  gz="$(gzip_size "$path")"
  printf '  %-7s %s\n' "$label" "$(basename "$path")"
  printf '    raw : %s\n' "$(format_size "$raw")"
  printf '    gzip: %s\n' "$(format_size "$gz")"
}

ENTRY_RAW="$(raw_size "$ENTRY_PATH")"
ENTRY_GZIP="$(gzip_size "$ENTRY_PATH")"

echo
echo "repro-summary:"
echo "  budget (entry chunk raw): $(format_size "$ENTRY_BUDGET_BYTES")"
echo
echo "  entry chunk (referenced from dist/index.html):"
print_chunk "entry" "$ENTRY_PATH"

echo
echo "  major sibling chunks (raw >= $(format_size "$MAJOR_CHUNK_THRESHOLD_BYTES")):"
found_any=0
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  [[ "$f" == "$ENTRY_PATH" ]] && continue
  raw="$(raw_size "$f")"
  if (( raw >= MAJOR_CHUNK_THRESHOLD_BYTES )); then
    print_chunk "vendor" "$f"
    found_any=1
  fi
done < <(find "$ASSETS_DIR" -maxdepth 1 -type f -name '*.js' | LC_ALL=C sort)
if (( ! found_any )); then
  echo "    (none)"
fi

echo
echo "  decision input:"
echo "    entry raw bytes : ${ENTRY_RAW}"
echo "    entry gzip bytes: ${ENTRY_GZIP}"
echo "    budget bytes    : ${ENTRY_BUDGET_BYTES}"
echo "    expect-issue    : ${EXPECT_ISSUE}"
echo

if (( EXPECT_ISSUE == 1 )); then
  if (( ENTRY_RAW > ENTRY_BUDGET_BYTES )); then
    echo "repro: PASS (--expect-issue) -- entry chunk ${ENTRY_RAW} bytes exceeds budget ${ENTRY_BUDGET_BYTES} bytes; baseline bug confirmed"
    exit 0
  fi
  echo "repro: FAIL (--expect-issue) -- entry chunk ${ENTRY_RAW} bytes is already within budget ${ENTRY_BUDGET_BYTES} bytes; bug appears fixed" >&2
  exit 1
fi

if (( ENTRY_RAW <= ENTRY_BUDGET_BYTES )); then
  echo "repro: PASS -- entry chunk ${ENTRY_RAW} bytes is within budget ${ENTRY_BUDGET_BYTES} bytes"
  exit 0
fi
echo "repro: FAIL -- entry chunk ${ENTRY_RAW} bytes exceeds budget ${ENTRY_BUDGET_BYTES} bytes" >&2
exit 1
