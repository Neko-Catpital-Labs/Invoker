#!/usr/bin/env bash
#
# Deterministic repro for the @invoker/ui startup bundle size.
#
# The production UI build currently emits a single ~1.77 MB entry chunk that
# the renderer must download, parse, and evaluate before the workflow graph
# can mount. Vite's own warning text ("Some chunks are larger than 500 kB")
# is the only existing signal, and that warning is advisory only -- the
# build still exits 0. This script adds a repo-local, exit-code-driven gate
# with explicit raw + gzip budgets so we can track the regression and prove
# the optimization.
#
# What it does:
#   1. Builds @invoker/ui (vite build) into packages/ui/dist.
#   2. Parses packages/ui/dist/index.html to identify the entry chunk
#      (the script the HTML document actually loads on startup).
#   3. Reports raw + gzip sizes for the entry chunk and every other major
#      chunk under dist/assets (>= 10 KB raw).
#   4. Compares the entry chunk against ENTRY_RAW_BUDGET_BYTES and, if set,
#      ENTRY_GZIP_BUDGET_BYTES.
#
# Modes:
#   --expect-issue   PASS when the entry chunk EXCEEDS the budget (confirms
#                    the regression exists today; baseline mode).
#   (default)        PASS only when the entry chunk is UNDER the budget
#                    (validates the optimization after the fix).
#
# Documented budgets (override via env vars if needed):
#   ENTRY_RAW_BUDGET_BYTES  default 1048576   (1.00 MiB raw)
#   ENTRY_GZIP_BUDGET_BYTES default  368640   (360 KiB gzip)
#
# Rationale for the raw budget: the current bundle is ~1.77 MiB; 1 MiB is
# a meaningful step down that requires code-splitting work, and it leaves
# headroom below the next round-number cliff (2 MiB) so cosmetic growth
# does not flip the gate.

set -euo pipefail

EXPECT_ISSUE=0
ENTRY_RAW_BUDGET_BYTES="${ENTRY_RAW_BUDGET_BYTES:-1048576}"
ENTRY_GZIP_BUDGET_BYTES="${ENTRY_GZIP_BUDGET_BYTES:-368640}"
MAJOR_CHUNK_THRESHOLD_BYTES="${MAJOR_CHUNK_THRESHOLD_BYTES:-10240}"
SKIP_BUILD="${SKIP_BUILD:-0}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue            PASS only when the @invoker/ui entry chunk EXCEEDS
                            the documented budget (baseline / pre-fix mode).
  --skip-build              Reuse an existing packages/ui/dist instead of
                            running 'pnpm --filter @invoker/ui build'.
  -h, --help                Show this help.

Environment overrides:
  ENTRY_RAW_BUDGET_BYTES        Raw byte budget for the entry chunk
                                (default: ${ENTRY_RAW_BUDGET_BYTES}).
  ENTRY_GZIP_BUDGET_BYTES       Gzip byte budget for the entry chunk
                                (default: ${ENTRY_GZIP_BUDGET_BYTES}; set
                                to 0 to disable the gzip check).
  MAJOR_CHUNK_THRESHOLD_BYTES   Raw byte threshold for reporting chunks as
                                "major" (default: ${MAJOR_CHUNK_THRESHOLD_BYTES}).
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

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "repro: building @invoker/ui..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/ui build)
fi

if [[ ! -f "$INDEX_HTML" ]]; then
  echo "repro: missing $INDEX_HTML (build did not produce dist/index.html)" >&2
  exit 1
fi
if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "repro: missing $ASSETS_DIR (build did not produce dist/assets/)" >&2
  exit 1
fi

EXPECT_ISSUE="$EXPECT_ISSUE" \
ENTRY_RAW_BUDGET_BYTES="$ENTRY_RAW_BUDGET_BYTES" \
ENTRY_GZIP_BUDGET_BYTES="$ENTRY_GZIP_BUDGET_BYTES" \
MAJOR_CHUNK_THRESHOLD_BYTES="$MAJOR_CHUNK_THRESHOLD_BYTES" \
INDEX_HTML="$INDEX_HTML" \
ASSETS_DIR="$ASSETS_DIR" \
python3 - <<'PY'
from __future__ import annotations

import gzip
import html.parser
import os
import sys
from pathlib import Path
from typing import List, Optional, Tuple

expect_issue = os.environ["EXPECT_ISSUE"] == "1"
entry_raw_budget = int(os.environ["ENTRY_RAW_BUDGET_BYTES"])
entry_gzip_budget = int(os.environ["ENTRY_GZIP_BUDGET_BYTES"])
major_threshold = int(os.environ["MAJOR_CHUNK_THRESHOLD_BYTES"])
index_html = Path(os.environ["INDEX_HTML"])
assets_dir = Path(os.environ["ASSETS_DIR"])


class EntryFinder(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.entry_src: Optional[str] = None

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        if tag.lower() != "script":
            return
        attr_map = {k.lower(): (v or "") for k, v in attrs}
        if attr_map.get("type", "").lower() != "module":
            return
        src = attr_map.get("src")
        if not src:
            return
        if self.entry_src is None:
            self.entry_src = src


parser = EntryFinder()
parser.feed(index_html.read_text(encoding="utf-8"))
entry_src = parser.entry_src
if not entry_src:
    print(f"repro: could not find a <script type=module src=...> in {index_html}", file=sys.stderr)
    sys.exit(2)

entry_path = (index_html.parent / entry_src).resolve()
if not entry_path.is_file():
    print(f"repro: entry chunk referenced by index.html does not exist: {entry_path}", file=sys.stderr)
    sys.exit(2)


def measure(path: Path) -> Tuple[int, int]:
    raw = path.read_bytes()
    gz = gzip.compress(raw, compresslevel=9, mtime=0)
    return len(raw), len(gz)


def fmt_kb(n: int) -> str:
    return f"{n / 1024:>9.2f} KiB ({n} B)"


entry_raw, entry_gzip = measure(entry_path)

other_chunks = []
for child in sorted(assets_dir.iterdir()):
    if not child.is_file():
        continue
    if child.resolve() == entry_path:
        continue
    if child.suffix != ".js":
        continue
    raw, gz = measure(child)
    other_chunks.append((child.name, raw, gz))

print("repro-summary:")
print(f"  index.html: {index_html}")
print(f"  entry chunk: {entry_path.name}")
print(f"    raw : {fmt_kb(entry_raw)}")
print(f"    gzip: {fmt_kb(entry_gzip)}")
print(f"  budgets:")
print(f"    raw  budget: {fmt_kb(entry_raw_budget)}")
if entry_gzip_budget > 0:
    print(f"    gzip budget: {fmt_kb(entry_gzip_budget)}")
else:
    print("    gzip budget: (disabled)")
print(f"  major JS chunks (>= {fmt_kb(major_threshold).strip()}):")
shown = 0
for name, raw, gz in sorted(other_chunks, key=lambda t: -t[1]):
    if raw < major_threshold:
        continue
    print(f"    - {name}: raw {fmt_kb(raw)}  gzip {fmt_kb(gz)}")
    shown += 1
if shown == 0:
    print("    (none)")

raw_over = entry_raw > entry_raw_budget
gzip_over = entry_gzip_budget > 0 and entry_gzip > entry_gzip_budget
over_budget = raw_over or gzip_over

reasons = []
if raw_over:
    reasons.append(f"raw {entry_raw} B > budget {entry_raw_budget} B")
if gzip_over:
    reasons.append(f"gzip {entry_gzip} B > budget {entry_gzip_budget} B")
within = []
if not raw_over:
    within.append(f"raw {entry_raw} B <= budget {entry_raw_budget} B")
if entry_gzip_budget > 0 and not gzip_over:
    within.append(f"gzip {entry_gzip} B <= budget {entry_gzip_budget} B")

if expect_issue:
    if over_budget:
        print(f"repro: PASS (--expect-issue) -- entry chunk over budget: {'; '.join(reasons)}")
        sys.exit(0)
    print(
        "repro: FAIL (--expect-issue) -- entry chunk is already within budget: "
        + "; ".join(within),
        file=sys.stderr,
    )
    sys.exit(1)

if over_budget:
    print(
        "repro: FAIL -- entry chunk exceeds budget: " + "; ".join(reasons),
        file=sys.stderr,
    )
    sys.exit(1)

print("repro: PASS -- entry chunk within budget: " + "; ".join(within))
sys.exit(0)
PY
