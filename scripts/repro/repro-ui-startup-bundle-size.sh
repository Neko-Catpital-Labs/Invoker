#!/usr/bin/env bash
#
# Deterministic repro for the UI production bundle's oversized entry chunk.
#
# Today (before the optimization) the @invoker/ui Vite build emits an
# index-<hash>.js entry chunk of roughly 1.77 MiB raw / 540 KiB gzip.
# That single chunk is downloaded, parsed, and evaluated on every cold
# start before the renderer can paint, so it is a plausible cold-start
# parse/evaluation cost contributor independent of graph layout. Vite
# already prints a >500 kB warning, but the warning text alone is not a
# durable gate: this script adds explicit, documented budgets in the repo
# so the check has a clear pass/fail exit code.
#
# What this script does:
#   1. Runs `pnpm --filter @invoker/ui build` from the repo root.
#   2. Reads `packages/ui/dist/index.html` to locate the entry chunk
#      referenced from the <script type="module"> tag.
#   3. Prints raw and gzip sizes for the entry chunk and every other
#      JS / CSS chunk under `packages/ui/dist/assets`, largest first.
#   4. Compares the entry chunk against documented budgets (raw + gzip).
#
# Modes:
#   --expect-issue   PASS (exit 0) when the entry chunk EXCEEDS the budget.
#                    Use this before the fix to confirm the issue is real.
#   (default)        PASS (exit 0) only when the entry chunk is UNDER the
#                    budget. Use this after the fix to validate that the
#                    optimization landed and stays in place.
#
# Documented budgets (override via env if needed):
#   ENTRY_CHUNK_RAW_BUDGET_BYTES   default: 1048576 (1.00 MiB)
#   ENTRY_CHUNK_GZIP_BUDGET_BYTES  default: 393216  ( 384 KiB)

set -euo pipefail

EXPECT_ISSUE=0
ENTRY_CHUNK_RAW_BUDGET_BYTES="${ENTRY_CHUNK_RAW_BUDGET_BYTES:-1048576}"
ENTRY_CHUNK_GZIP_BUDGET_BYTES="${ENTRY_CHUNK_GZIP_BUDGET_BYTES:-393216}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue   Exit 0 when the entry chunk is OVER budget (baseline:
                   confirms the bug exists today). Without this flag,
                   exit 0 only when the entry chunk is UNDER budget
                   (validates the optimization).
  -h, --help       Show this help.

Environment overrides:
  ENTRY_CHUNK_RAW_BUDGET_BYTES   default: 1048576 (1.00 MiB)
  ENTRY_CHUNK_GZIP_BUDGET_BYTES  default: 393216  ( 384 KiB)
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help)      usage; exit 0 ;;
    *)              echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
UI_DIR="$REPO_ROOT/packages/ui"
DIST_DIR="$UI_DIR/dist"
ASSETS_DIR="$DIST_DIR/assets"
INDEX_HTML="$DIST_DIR/index.html"

cd "$REPO_ROOT"

echo "==> Building @invoker/ui ..."
pnpm --filter @invoker/ui build >/dev/null

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "FAIL: $ASSETS_DIR not found after build" >&2
  exit 1
fi
if [[ ! -f "$INDEX_HTML" ]]; then
  echo "FAIL: $INDEX_HTML not found after build" >&2
  exit 1
fi

# The entry chunk is the script referenced from <script type="module" ... src="./assets/<entry>.js">.
ENTRY_REL="$(grep -oE 'src="\./assets/[^"]+\.js"' "$INDEX_HTML" \
  | head -n 1 \
  | sed -E 's/^src="\.\/(.*)"$/\1/')"
if [[ -z "$ENTRY_REL" ]]; then
  echo "FAIL: could not locate entry chunk <script> tag in $INDEX_HTML" >&2
  exit 1
fi

ENTRY_PATH="$DIST_DIR/$ENTRY_REL"
if [[ ! -f "$ENTRY_PATH" ]]; then
  echo "FAIL: entry chunk file $ENTRY_PATH does not exist" >&2
  exit 1
fi

raw_size() {
  wc -c <"$1" | tr -d ' '
}

gzip_size() {
  gzip -c -9 "$1" | wc -c | tr -d ' '
}

fmt_kib() {
  awk -v b="$1" 'BEGIN { printf "%8.2f KiB", b/1024 }'
}

print_chunk() {
  local label="$1" path="$2"
  local raw gz
  raw="$(raw_size "$path")"
  gz="$(gzip_size "$path")"
  printf "  %-7s %-40s raw=%s  gzip=%s\n" \
    "$label" "$(basename "$path")" "$(fmt_kib "$raw")" "$(fmt_kib "$gz")"
}

echo ""
echo "==> packages/ui/dist/assets contents (largest JS first):"
echo ""
print_chunk "ENTRY" "$ENTRY_PATH"

# Other JS chunks, largest first, excluding the entry chunk.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  print_chunk "chunk" "$line"
done < <(
  find "$ASSETS_DIR" -maxdepth 1 -type f -name '*.js' ! -path "$ENTRY_PATH" \
    -exec wc -c {} \; \
    | sort -rn \
    | sed -E 's/^[[:space:]]+[0-9]+[[:space:]]+//'
)

# CSS chunks for context (not budgeted).
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  print_chunk "css" "$line"
done < <(find "$ASSETS_DIR" -maxdepth 1 -type f -name '*.css' | sort)

ENTRY_RAW="$(raw_size "$ENTRY_PATH")"
ENTRY_GZ="$(gzip_size "$ENTRY_PATH")"

echo ""
echo "==> Budgets (entry chunk only):"
echo "    raw   budget: $(fmt_kib "$ENTRY_CHUNK_RAW_BUDGET_BYTES")   actual: $(fmt_kib "$ENTRY_RAW")"
echo "    gzip  budget: $(fmt_kib "$ENTRY_CHUNK_GZIP_BUDGET_BYTES")   actual: $(fmt_kib "$ENTRY_GZ")"
echo ""

OVER_BUDGET=0
if (( ENTRY_RAW > ENTRY_CHUNK_RAW_BUDGET_BYTES )); then
  OVER_BUDGET=1
fi
if (( ENTRY_GZ > ENTRY_CHUNK_GZIP_BUDGET_BYTES )); then
  OVER_BUDGET=1
fi

if (( EXPECT_ISSUE == 1 )); then
  if (( OVER_BUDGET == 1 )); then
    echo "PASS (--expect-issue): entry chunk is over budget, the issue reproduces."
    exit 0
  fi
  echo "FAIL (--expect-issue): entry chunk is within budget but baseline expected over budget." >&2
  exit 1
fi

if (( OVER_BUDGET == 0 )); then
  echo "PASS: entry chunk is within budget."
  exit 0
fi
echo "FAIL: entry chunk exceeds budget; optimization not applied." >&2
exit 1
