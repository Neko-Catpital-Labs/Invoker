#!/usr/bin/env bash
#
# Deterministic repro for the oversized @invoker/ui startup bundle.
#
# Today the production UI build emits a single ~1.77MB entry chunk
# (dist/assets/index-<hash>.js). That blob has to be parsed and evaluated
# on every cold start before the renderer can paint -- a plausible
# cold-start cost separate from graph layout. Vite already warns at
# build time ("Some chunks are larger than 500 kB after minification"),
# but the warning is informational and cannot gate CI. This script adds
# an explicit, repo-local budget that can.
#
# Modes:
#   --expect-issue   PASS when the entry chunk exceeds the documented
#                    budget (confirms the bug exists today).
#   (default)        PASS only when the entry chunk is under the
#                    documented budget (validates the optimization).
#
# Budgets are documented constants in this script (and can be overridden
# via env for ad-hoc experimentation):
#   ENTRY_RAW_BUDGET_BYTES   -- raw (minified) size budget for the JS entry
#   ENTRY_GZIP_BUDGET_BYTES  -- gzip size budget for the JS entry

set -euo pipefail

# ── Documented budgets ────────────────────────────────────────
# Today: entry is ~1,773.92 kB raw / ~540.34 kB gzip.
# Target: post-split, the entry chunk should comfortably fit under 1 MiB
# raw and 320 KiB gzip so the renderer can parse it during the same tick
# that paints the empty graph shell.
ENTRY_RAW_BUDGET_BYTES="${ENTRY_RAW_BUDGET_BYTES:-1048576}"   # 1 MiB
ENTRY_GZIP_BUDGET_BYTES="${ENTRY_GZIP_BUDGET_BYTES:-327680}"  # 320 KiB

EXPECT_ISSUE=0

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue                 PASS only if the @invoker/ui entry chunk
                                 exceeds the documented budget (baseline
                                 mode -- confirms the bug exists today).
  -h, --help                     Show this help.

Environment overrides:
  ENTRY_RAW_BUDGET_BYTES         Raw (minified) JS entry budget in bytes
                                 (default: ${ENTRY_RAW_BUDGET_BYTES}).
  ENTRY_GZIP_BUDGET_BYTES        Gzip JS entry budget in bytes
                                 (default: ${ENTRY_GZIP_BUDGET_BYTES}).
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

echo "repro: building @invoker/ui (pnpm --filter @invoker/ui build)..."
(cd "$REPO_ROOT" && pnpm --filter @invoker/ui build >/dev/null)

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "repro: expected build output at $ASSETS_DIR -- missing" >&2
  exit 1
fi

raw_size() {
  # Portable byte count (stat -c on GNU, stat -f on BSD/macOS).
  if stat -c%s "$1" >/dev/null 2>&1; then
    stat -c%s "$1"
  else
    stat -f%z "$1"
  fi
}

gzip_size() {
  # gzip -9 mirrors Vite's reported "gzip:" column closely enough for
  # budgeting; we only care about the order of magnitude, not exact bytes.
  gzip -9 -c "$1" | wc -c | tr -d '[:space:]'
}

format_bytes() {
  local n="$1"
  awk -v n="$n" 'BEGIN { printf "%10d B (%.2f KiB)", n, n/1024 }'
}

# Entry chunk is the JS file named index-<hash>.js. There should be
# exactly one; if Vite ever emits more we surface that as an error so
# the budget check doesn't quietly miss a regression.
mapfile -t entry_candidates < <(
  find "$ASSETS_DIR" -maxdepth 1 -type f -name 'index-*.js' | sort
)

if (( ${#entry_candidates[@]} == 0 )); then
  echo "repro: no entry chunk matching dist/assets/index-*.js was emitted" >&2
  ls -la "$ASSETS_DIR" >&2 || true
  exit 1
fi
if (( ${#entry_candidates[@]} > 1 )); then
  echo "repro: multiple entry candidates found -- update the script:" >&2
  printf '  %s\n' "${entry_candidates[@]}" >&2
  exit 1
fi

entry_chunk="${entry_candidates[0]}"
entry_raw="$(raw_size "$entry_chunk")"
entry_gz="$(gzip_size "$entry_chunk")"

# Major chunks: every other top-level JS file in dist/assets, sorted by
# raw size (largest first) so the report makes regressions in vendor
# chunks visible too.
mapfile -t other_chunks < <(
  find "$ASSETS_DIR" -maxdepth 1 -type f -name '*.js' ! -path "$entry_chunk" \
    | while read -r f; do printf '%s\t%s\n' "$(raw_size "$f")" "$f"; done \
    | sort -rn \
    | cut -f2-
)

echo
echo "repro: dist/assets/ chunk sizes"
echo "  entry chunk: $(basename "$entry_chunk")"
echo "    raw:  $(format_bytes "$entry_raw")"
echo "    gzip: $(format_bytes "$entry_gz")"
echo "  budget:"
echo "    raw:  $(format_bytes "$ENTRY_RAW_BUDGET_BYTES")"
echo "    gzip: $(format_bytes "$ENTRY_GZIP_BUDGET_BYTES")"
if (( ${#other_chunks[@]} > 0 )); then
  echo "  other JS chunks (raw, gzip):"
  for chunk in "${other_chunks[@]}"; do
    other_raw="$(raw_size "$chunk")"
    other_gz="$(gzip_size "$chunk")"
    printf '    %-32s raw=%s  gzip=%s\n' \
      "$(basename "$chunk")" \
      "$(format_bytes "$other_raw")" \
      "$(format_bytes "$other_gz")"
  done
fi
echo

over_raw=0
over_gz=0
(( entry_raw > ENTRY_RAW_BUDGET_BYTES )) && over_raw=1
(( entry_gz  > ENTRY_GZIP_BUDGET_BYTES )) && over_gz=1
over_budget=0
(( over_raw || over_gz )) && over_budget=1

if (( EXPECT_ISSUE )); then
  if (( over_budget )); then
    echo "repro: PASS (--expect-issue) -- entry chunk exceeds budget" \
      "(raw_over=${over_raw}, gzip_over=${over_gz})"
    exit 0
  fi
  echo "repro: FAIL (--expect-issue) -- entry chunk is already within" \
    "budget; the bug appears to be already fixed" >&2
  exit 1
fi

if (( over_budget )); then
  echo "repro: FAIL -- entry chunk exceeds documented budget" \
    "(raw_over=${over_raw}, gzip_over=${over_gz})" >&2
  exit 1
fi

echo "repro: PASS -- entry chunk is within documented budget"
exit 0
