#!/usr/bin/env bash
#
# Repro: the production @invoker/ui build ships an oversized entry chunk.
#
# Motivation: the UI entry chunk (dist/assets/index-*.js) is ~1.77 MB raw, which
# the browser must parse and evaluate on cold start. That is a plausible
# cold-start latency risk that is independent of graph-layout work, so we guard
# it with an explicit, repo-local budget rather than trusting Vite's soft
# "chunks are larger than 500 kB" warning text (which never changes exit code).
#
# Behaviour:
#   * default (no flag): the build is considered HEALTHY. Exit 0 only when the
#     entry chunk is at/under budget. This is the post-optimization gate.
#   * --expect-issue: the build is expected to be OVER budget. Exit 0 only when
#     the entry chunk EXCEEDS the budget. This is the pre-fix reproduction gate
#     and is used to prove the bug exists before the optimization lands.
#
# In both modes the script builds the UI, then prints raw + gzip sizes for the
# entry chunk and every major JS chunk.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Documented budget.
#
# ENTRY_RAW_BUDGET_BYTES is the maximum acceptable *raw* (un-gzipped) size of the
# entry chunk, because raw bytes drive parse/evaluation cost on cold start.
# Default: 1,200,000 bytes (~1.14 MiB). The current pre-fix entry chunk is
# ~1,773,987 bytes, so it is comfortably over budget; a code-split build that
# moves heavy vendor code (elkjs, react-dom, xterm, @xyflow/react) out of the
# entry chunk is expected to land well under this ceiling.
#
# Override via environment for experimentation, e.g.
#   ENTRY_RAW_BUDGET_BYTES=1000000 scripts/repro/repro-ui-startup-bundle-size.sh
# ---------------------------------------------------------------------------
ENTRY_RAW_BUDGET_BYTES="${ENTRY_RAW_BUDGET_BYTES:-1200000}"

EXPECT_ISSUE=0
for arg in "$@"; do
  case "$arg" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      echo "usage: $0 [--expect-issue]" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSETS_DIR="$REPO_ROOT/packages/ui/dist/assets"

echo "==> Building @invoker/ui (production)"
pnpm --filter @invoker/ui build

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "error: build did not produce $ASSETS_DIR" >&2
  exit 1
fi

# Locate the single entry chunk: dist/assets/index-<hash>.js
shopt -s nullglob
entry_candidates=("$ASSETS_DIR"/index-*.js)
shopt -u nullglob

if [[ ${#entry_candidates[@]} -eq 0 ]]; then
  echo "error: no entry chunk (index-*.js) found in $ASSETS_DIR" >&2
  exit 1
fi
if [[ ${#entry_candidates[@]} -gt 1 ]]; then
  echo "error: expected exactly one entry chunk, found ${#entry_candidates[@]}:" >&2
  printf '  %s\n' "${entry_candidates[@]}" >&2
  exit 1
fi
ENTRY_CHUNK="${entry_candidates[0]}"

# Helpers -------------------------------------------------------------------
raw_bytes()  { wc -c < "$1" | tr -d '[:space:]'; }
gzip_bytes() { gzip -c "$1" | wc -c | tr -d '[:space:]'; }
kib()        { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1024 }'; }

echo
echo "==> JS chunk sizes in packages/ui/dist/assets (largest first)"
printf '%-34s %14s %14s\n' "chunk" "raw" "gzip"
printf '%-34s %14s %14s\n' "-----" "---" "----"

# Sort all JS chunks by raw size, descending, and print raw + gzip for each.
while IFS= read -r chunk; do
  [[ -n "$chunk" ]] || continue
  name="$(basename "$chunk")"
  r="$(raw_bytes "$chunk")"
  g="$(gzip_bytes "$chunk")"
  marker=""
  [[ "$chunk" == "$ENTRY_CHUNK" ]] && marker="  <- entry"
  printf '%-34s %10s KiB %10s KiB%s\n' "$name" "$(kib "$r")" "$(kib "$g")" "$marker"
done < <(
  shopt -s nullglob
  for f in "$ASSETS_DIR"/*.js; do
    printf '%s\t%s\n' "$(raw_bytes "$f")" "$f"
  done | sort -rn | cut -f2-
)

ENTRY_RAW="$(raw_bytes "$ENTRY_CHUNK")"
ENTRY_GZIP="$(gzip_bytes "$ENTRY_CHUNK")"

echo
echo "==> Entry chunk budget check"
echo "    entry chunk : $(basename "$ENTRY_CHUNK")"
echo "    raw size    : ${ENTRY_RAW} bytes ($(kib "$ENTRY_RAW") KiB)"
echo "    gzip size   : ${ENTRY_GZIP} bytes ($(kib "$ENTRY_GZIP") KiB)"
echo "    raw budget  : ${ENTRY_RAW_BUDGET_BYTES} bytes ($(kib "$ENTRY_RAW_BUDGET_BYTES") KiB)"

over_budget=0
if [[ "$ENTRY_RAW" -gt "$ENTRY_RAW_BUDGET_BYTES" ]]; then
  over_budget=1
fi

if [[ "$EXPECT_ISSUE" -eq 1 ]]; then
  if [[ "$over_budget" -eq 1 ]]; then
    echo
    echo "REPRO CONFIRMED: entry chunk is OVER budget (${ENTRY_RAW} > ${ENTRY_RAW_BUDGET_BYTES} bytes)."
    echo "This is the expected pre-fix state."
    exit 0
  fi
  echo
  echo "REPRO FAILED: entry chunk is within budget (${ENTRY_RAW} <= ${ENTRY_RAW_BUDGET_BYTES} bytes)."
  echo "The oversized-bundle issue no longer reproduces; drop --expect-issue to gate the fix."
  exit 1
fi

if [[ "$over_budget" -eq 1 ]]; then
  echo
  echo "BUDGET EXCEEDED: entry chunk is OVER budget (${ENTRY_RAW} > ${ENTRY_RAW_BUDGET_BYTES} bytes)."
  echo "Reduce the entry chunk (e.g. code-split heavy vendor deps) or re-run with"
  echo "--expect-issue to assert the known pre-fix state."
  exit 1
fi

echo
echo "OK: entry chunk is within budget (${ENTRY_RAW} <= ${ENTRY_RAW_BUDGET_BYTES} bytes)."
exit 0
