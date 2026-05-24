#!/usr/bin/env bash
#
# Deterministic repro for the @invoker/ui startup bundle size regression.
#
# Today, `pnpm --filter @invoker/ui build` emits an entry chunk
# (`packages/ui/dist/assets/index-*.js`, referenced from
# `packages/ui/dist/index.html`) weighing ~1.77MB raw / ~540KB gzip. That
# single chunk has to be parsed and evaluated before the renderer can
# bootstrap, which is a plausible cold-start cost on top of any graph
# layout work and is a separate issue from the redundant post-bootstrap
# snapshot fix.
#
# This script:
#   1. Rebuilds the UI via the workspace `build` script.
#   2. Inspects every JS file under `packages/ui/dist/assets`.
#   3. Prints raw and gzip sizes for the entry chunk (parsed out of
#      `index.html`) and every other major chunk.
#   4. Compares the entry chunk's raw size against a documented budget
#      (default 1,000,000 bytes / ~977 KiB raw).
#
# Modes:
#   --expect-issue   PASS (exit 0) when the entry chunk is OVER budget
#                    (confirms the bundle-size issue exists today).
#   (default)        PASS (exit 0) only when the entry chunk is UNDER
#                    budget (validates the optimization).
#
# The budget can be overridden with --budget-bytes / $ENTRY_BUDGET_BYTES.

set -euo pipefail

EXPECT_ISSUE=0
ENTRY_BUDGET_BYTES="${ENTRY_BUDGET_BYTES:-1000000}"
SKIP_BUILD="${SKIP_BUILD:-0}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue            PASS only if the entry chunk EXCEEDS the budget
                            (baseline mode: confirms the issue exists today).
  --budget-bytes N          Documented raw-byte budget for the entry chunk
                            (default: ${ENTRY_BUDGET_BYTES} bytes).
  --skip-build              Reuse an existing packages/ui/dist tree instead
                            of rebuilding (useful for repeated invocations).
  -h, --help                Show this help.

Environment overrides:
  ENTRY_BUDGET_BYTES        Same as --budget-bytes.
  SKIP_BUILD=1              Same as --skip-build.
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue)        EXPECT_ISSUE=1 ;;
    --budget-bytes)        shift; ENTRY_BUDGET_BYTES="$1" ;;
    --budget-bytes=*)      ENTRY_BUDGET_BYTES="${1#*=}" ;;
    --skip-build)          SKIP_BUILD=1 ;;
    -h|--help)             usage; exit 0 ;;
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
  echo "repro: building @invoker/ui (pnpm --filter @invoker/ui build)..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/ui build)
else
  echo "repro: SKIP_BUILD=1 -- reusing existing $DIST_DIR"
fi

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "repro: expected build output at $ASSETS_DIR, but it does not exist" >&2
  exit 1
fi
if [[ ! -f "$INDEX_HTML" ]]; then
  echo "repro: expected $INDEX_HTML to exist after build" >&2
  exit 1
fi

# Parse the entry chunk file name out of index.html. Vite emits a single
# `<script type="module" crossorigin src="./assets/<entry>.js"></script>`
# tag for the entry, distinct from any modulepreload link tags.
ENTRY_REL="$(
  ENTRY_HTML="$INDEX_HTML" python3 - <<'PY'
import os
import re
import sys

html_path = os.environ["ENTRY_HTML"]
with open(html_path, "r", encoding="utf-8") as fh:
    html = fh.read()

match = re.search(
    r'<script\b[^>]*\bsrc="(?P<src>[^"]+\.js)"',
    html,
)
if not match:
    print("repro: could not find entry script tag in index.html", file=sys.stderr)
    sys.exit(1)

src = match.group("src")
# Normalize "./assets/foo.js" → "assets/foo.js" so it joins cleanly under dist/.
if src.startswith("./"):
    src = src[2:]
print(src)
PY
)"

ENTRY_PATH="$DIST_DIR/$ENTRY_REL"
if [[ ! -f "$ENTRY_PATH" ]]; then
  echo "repro: entry chunk referenced by index.html does not exist: $ENTRY_PATH" >&2
  exit 1
fi

# Stable, cross-platform byte-size helper. macOS `stat -f%z`, GNU `stat -c%s`.
file_size_bytes() {
  if stat -f%z "$1" >/dev/null 2>&1; then
    stat -f%z "$1"
  else
    stat -c%s "$1"
  fi
}

gzip_size_bytes() {
  gzip -c -9 "$1" | wc -c | tr -d ' '
}

ENTRY_BASENAME="$(basename "$ENTRY_PATH")"
ENTRY_RAW="$(file_size_bytes "$ENTRY_PATH")"
ENTRY_GZIP="$(gzip_size_bytes "$ENTRY_PATH")"

echo
echo "repro-summary:"
printf '  entry chunk:    %s\n' "$ENTRY_REL"
printf '  entry raw:      %s bytes\n' "$ENTRY_RAW"
printf '  entry gzip:     %s bytes\n' "$ENTRY_GZIP"
printf '  entry budget:   %s bytes (raw)\n' "$ENTRY_BUDGET_BYTES"
echo
echo "  all .js chunks under dist/assets (sorted by raw size, desc):"

# Print every chunk sorted by raw size descending. Mark the entry chunk
# so the operator can tell at a glance which one is over budget.
while IFS= read -r -d '' js_file; do
  base="$(basename "$js_file")"
  raw="$(file_size_bytes "$js_file")"
  gz="$(gzip_size_bytes "$js_file")"
  marker="          "
  if [[ "$base" == "$ENTRY_BASENAME" ]]; then
    marker="  [entry] "
  else
    marker="          "
  fi
  printf '%s%-40s raw=%10s bytes  gzip=%10s bytes\n' \
    "$marker" "$base" "$raw" "$gz"
done < <(find "$ASSETS_DIR" -maxdepth 1 -type f -name '*.js' -print0) \
  | sort -k4 -n -r

echo

if (( ENTRY_RAW > ENTRY_BUDGET_BYTES )); then
  ENTRY_STATUS="OVER"
else
  ENTRY_STATUS="UNDER"
fi

echo "  entry chunk is $ENTRY_STATUS budget ($ENTRY_RAW vs $ENTRY_BUDGET_BYTES bytes)"
echo

if [[ "$EXPECT_ISSUE" = "1" ]]; then
  if [[ "$ENTRY_STATUS" = "OVER" ]]; then
    echo "repro: PASS (--expect-issue) -- entry chunk $ENTRY_RAW bytes exceeds budget $ENTRY_BUDGET_BYTES"
    exit 0
  fi
  echo "repro: FAIL (--expect-issue) -- entry chunk $ENTRY_RAW bytes is already within budget $ENTRY_BUDGET_BYTES; bundle appears already optimized" >&2
  exit 1
fi

if [[ "$ENTRY_STATUS" = "UNDER" ]]; then
  echo "repro: PASS -- entry chunk $ENTRY_RAW bytes is within budget $ENTRY_BUDGET_BYTES"
  exit 0
fi

echo "repro: FAIL -- entry chunk $ENTRY_RAW bytes exceeds budget $ENTRY_BUDGET_BYTES" >&2
exit 1
