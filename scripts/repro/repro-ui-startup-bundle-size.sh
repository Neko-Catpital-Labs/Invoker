#!/usr/bin/env bash
#
# Deterministic repro for UI entry-chunk bundle size.
#
# The production UI build produces a ~1.77 MB entry chunk (before gzip).
# That is a cold-start parse/evaluation risk in the Electron renderer,
# independent of graph-layout cost.  This script builds @invoker/ui,
# measures raw and gzip sizes for every JS chunk in dist/assets, and
# enforces an explicit size budget on the entry chunk.
#
# Modes:
#   --expect-issue   PASS when the entry chunk EXCEEDS the budget
#                    (confirms the oversized bundle exists today).
#   (default)        PASS only when the entry chunk is UNDER the budget
#                    (validates the optimization).

set -euo pipefail

EXPECT_ISSUE=0
ENTRY_BUDGET_KB="${ENTRY_BUDGET_KB:-1500}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue          PASS only if the entry chunk exceeds the budget
                          (baseline mode, before optimization).
  --budget KB             Entry-chunk budget in KB (default: ${ENTRY_BUDGET_KB}).
  -h, --help              Show this help.
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue)   EXPECT_ISSUE=1 ;;
    --budget)         shift; ENTRY_BUDGET_KB="$1" ;;
    --budget=*)       ENTRY_BUDGET_KB="${1#*=}" ;;
    -h|--help)        usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIST_ASSETS="$REPO_ROOT/packages/ui/dist/assets"

# ── Build ────────────────────────────────────────────────────────
echo "repro: building @invoker/ui..."
(cd "$REPO_ROOT" && pnpm --filter @invoker/ui build >/dev/null 2>&1)

if [[ ! -d "$DIST_ASSETS" ]]; then
  echo "repro: FAIL -- dist/assets not found after build" >&2
  exit 1
fi

# ── Measure ──────────────────────────────────────────────────────
# Vite manual-chunk names from vite.config.ts: react, xyflow, xterm.
# The entry chunk is the JS file that does NOT match a vendor chunk name.
VENDOR_PATTERN="^(react|xyflow|xterm)-"

entry_file=""
declare -a vendor_files=()
declare -a other_files=()

for f in "$DIST_ASSETS"/*.js; do
  [[ -f "$f" ]] || continue
  base="$(basename "$f")"
  if [[ "$base" =~ $VENDOR_PATTERN ]]; then
    vendor_files+=("$f")
  elif [[ -z "$entry_file" ]]; then
    entry_file="$f"
  else
    other_files+=("$f")
  fi
done

if [[ -z "$entry_file" ]]; then
  echo "repro: FAIL -- no entry JS chunk found in $DIST_ASSETS" >&2
  exit 1
fi

human_kb() {
  local bytes="$1"
  echo "$(( (bytes + 512) / 1024 )) KB"
}

print_chunk() {
  local label="$1" file="$2"
  local raw_bytes gzip_bytes
  raw_bytes="$(wc -c < "$file" | tr -d ' ')"
  gzip_bytes="$(gzip -c "$file" | wc -c | tr -d ' ')"
  printf "  %-40s  raw: %8s  gzip: %8s\n" \
    "$label ($(basename "$file"))" \
    "$(human_kb "$raw_bytes")" \
    "$(human_kb "$gzip_bytes")"
}

raw_bytes_of() {
  wc -c < "$1" | tr -d ' '
}

echo ""
echo "repro-bundle-sizes:"

print_chunk "entry" "$entry_file"
entry_raw="$(raw_bytes_of "$entry_file")"

for vf in "${vendor_files[@]}"; do
  chunk_name="$(basename "$vf")"
  chunk_name="${chunk_name%%-*}"
  print_chunk "vendor/$chunk_name" "$vf"
done

for of in "${other_files[@]}"; do
  print_chunk "other" "$of"
done

for cf in "$DIST_ASSETS"/*.css; do
  [[ -f "$cf" ]] || continue
  print_chunk "css" "$cf"
done

echo ""

# ── Budget check ─────────────────────────────────────────────────
entry_raw_kb=$(( (entry_raw + 512) / 1024 ))

echo "repro: entry chunk = ${entry_raw_kb} KB (budget: ${ENTRY_BUDGET_KB} KB)"

if (( entry_raw_kb > ENTRY_BUDGET_KB )); then
  if (( EXPECT_ISSUE )); then
    echo "repro: PASS (--expect-issue) -- entry chunk ${entry_raw_kb} KB exceeds budget ${ENTRY_BUDGET_KB} KB"
    exit 0
  else
    echo "repro: FAIL -- entry chunk ${entry_raw_kb} KB exceeds budget ${ENTRY_BUDGET_KB} KB" >&2
    exit 1
  fi
else
  if (( EXPECT_ISSUE )); then
    echo "repro: FAIL (--expect-issue) -- entry chunk ${entry_raw_kb} KB is within budget ${ENTRY_BUDGET_KB} KB; issue appears already fixed" >&2
    exit 1
  else
    echo "repro: PASS -- entry chunk ${entry_raw_kb} KB is within budget ${ENTRY_BUDGET_KB} KB"
    exit 0
  fi
fi
