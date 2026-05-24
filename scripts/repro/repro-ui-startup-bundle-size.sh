#!/usr/bin/env bash
#
# Deterministic repro for the @invoker/ui production bundle size budget.
#
# Vite's build currently emits a single ~1.77MB entry chunk
# (dist/assets/index-*.js) because route components, ELK layout, xyflow,
# and supporting libraries are all reachable from the synchronous import
# graph rooted at src/main.tsx. That entry chunk is parsed and evaluated
# on the renderer's critical path during cold start, so its size is a
# separate cold-start risk from graph layout cost.
#
# This script builds @invoker/ui, inspects packages/ui/dist/assets, and
# enforces explicit byte budgets against the entry chunk. It is a pure
# byte-size check (no Electron) so it stays deterministic and fast.
#
# Budgets (override with env vars if intentionally re-baselining):
#   ENTRY_BUDGET_BYTES         raw entry chunk budget        (default: 1258291 ≈ 1.2 MiB)
#   ENTRY_BUDGET_GZIP_BYTES    gzip entry chunk budget       (default: 409600  ≈ 400 KiB)
#
# Modes:
#   --expect-issue   PASS when the entry chunk's raw size IS over the
#                    documented budget (confirms today's regression).
#   (default)        PASS only when the entry chunk's raw size is under
#                    the documented budget (validates the optimization).

set -euo pipefail

EXPECT_ISSUE=0
ENTRY_BUDGET_BYTES="${ENTRY_BUDGET_BYTES:-1258291}"
ENTRY_BUDGET_GZIP_BYTES="${ENTRY_BUDGET_GZIP_BYTES:-409600}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue                 PASS only if the entry chunk's raw size
                                 IS over ENTRY_BUDGET_BYTES (baseline mode).
  -h, --help                     Show this help.

Environment overrides:
  ENTRY_BUDGET_BYTES             Raw entry chunk budget in bytes
                                 (default: ${ENTRY_BUDGET_BYTES}).
  ENTRY_BUDGET_GZIP_BYTES        Gzip entry chunk budget in bytes
                                 (default: ${ENTRY_BUDGET_GZIP_BYTES}).
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSETS_DIR="$REPO_ROOT/packages/ui/dist/assets"

byte_size() {
  # Portable file-size in bytes (macOS BSD stat vs Linux GNU stat).
  if stat -f%z "$1" >/dev/null 2>&1; then
    stat -f%z "$1"
  else
    stat -c%s "$1"
  fi
}

gzip_size() {
  gzip -c -9 -n "$1" | wc -c | tr -d ' '
}

humanize() {
  # Render a byte count as "N bytes (X.YZ KiB / X.YZ MiB)".
  awk -v n="$1" 'BEGIN {
    kib = n / 1024.0;
    mib = kib / 1024.0;
    printf "%d bytes (%.2f KiB / %.2f MiB)", n, kib, mib;
  }'
}

echo "repro: building @invoker/ui (this rebuilds packages/ui/dist)..."
(
  cd "$REPO_ROOT"
  pnpm --filter @invoker/ui build
)

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "repro: expected assets directory at $ASSETS_DIR but it does not exist" >&2
  exit 1
fi

shopt -s nullglob
entry_candidates=("$ASSETS_DIR"/index-*.js)
shopt -u nullglob

if (( ${#entry_candidates[@]} == 0 )); then
  echo "repro: no entry chunk matching $ASSETS_DIR/index-*.js was emitted" >&2
  ls -la "$ASSETS_DIR" >&2 || true
  exit 1
fi
if (( ${#entry_candidates[@]} > 1 )); then
  echo "repro: expected exactly one index-*.js entry chunk, found ${#entry_candidates[@]}:" >&2
  printf '  %s\n' "${entry_candidates[@]}" >&2
  exit 1
fi

ENTRY_PATH="${entry_candidates[0]}"
ENTRY_NAME="$(basename "$ENTRY_PATH")"
ENTRY_RAW="$(byte_size "$ENTRY_PATH")"
ENTRY_GZIP="$(gzip_size "$ENTRY_PATH")"

echo
echo "repro-summary:"
echo "  entry chunk: $ENTRY_NAME"
echo "    raw:  $(humanize "$ENTRY_RAW")"
echo "    gzip: $(humanize "$ENTRY_GZIP")"
echo "  raw budget:  $(humanize "$ENTRY_BUDGET_BYTES")"
echo "  gzip budget: $(humanize "$ENTRY_BUDGET_GZIP_BYTES")"
echo
echo "  major chunks (>= 50 KiB raw, excluding entry):"
shopt -s nullglob
any_major=0
for chunk in "$ASSETS_DIR"/*.js "$ASSETS_DIR"/*.css; do
  [[ "$chunk" == "$ENTRY_PATH" ]] && continue
  raw="$(byte_size "$chunk")"
  if (( raw >= 51200 )); then
    gz="$(gzip_size "$chunk")"
    printf "    %-40s raw=%-8s gzip=%-8s\n" "$(basename "$chunk")" "$raw" "$gz"
    any_major=1
  fi
done
shopt -u nullglob
if (( any_major == 0 )); then
  echo "    (none)"
fi
echo

if [[ "$EXPECT_ISSUE" == "1" ]]; then
  if (( ENTRY_RAW > ENTRY_BUDGET_BYTES )); then
    echo "repro: PASS (--expect-issue) -- entry chunk raw $ENTRY_RAW bytes exceeds budget $ENTRY_BUDGET_BYTES bytes"
    exit 0
  fi
  echo "repro: FAIL (--expect-issue) -- entry chunk raw $ENTRY_RAW bytes is within budget $ENTRY_BUDGET_BYTES bytes; the regression appears to be already fixed" >&2
  exit 1
fi

fail=0
if (( ENTRY_RAW > ENTRY_BUDGET_BYTES )); then
  echo "repro: FAIL -- entry chunk raw $ENTRY_RAW bytes exceeds budget $ENTRY_BUDGET_BYTES bytes" >&2
  fail=1
fi
if (( ENTRY_GZIP > ENTRY_BUDGET_GZIP_BYTES )); then
  echo "repro: FAIL -- entry chunk gzip $ENTRY_GZIP bytes exceeds gzip budget $ENTRY_BUDGET_GZIP_BYTES bytes" >&2
  fail=1
fi
if (( fail != 0 )); then
  exit 1
fi

echo "repro: PASS -- entry chunk is within raw ($ENTRY_BUDGET_BYTES) and gzip ($ENTRY_BUDGET_GZIP_BYTES) budgets"
exit 0
