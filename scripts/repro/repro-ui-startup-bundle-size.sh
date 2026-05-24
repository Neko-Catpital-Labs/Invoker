#!/usr/bin/env bash
#
# Deterministic repro for the @invoker/ui startup bundle-size risk.
#
# The current production UI build emits a ~1.77 MiB entry chunk
# (dist/assets/index-<hash>.js). That is a plausible cold-start
# parse/evaluation risk separate from graph layout work, and Vite only
# logs a 500 KiB warning -- it does not fail the build. This script
# rebuilds @invoker/ui, inspects packages/ui/dist/assets, prints raw
# and gzip sizes for the entry chunk plus other major chunks, and
# enforces an explicit, repo-local byte budget on the entry chunk.
#
# Modes:
#   --expect-issue   PASS only when the entry chunk EXCEEDS the
#                    documented budget (baseline -- confirms today's
#                    bundle is over budget before the fix lands).
#   (default)        PASS only when the entry chunk is UNDER the
#                    budget (validates the optimization after the fix).
#
# Budget rationale:
#   ENTRY_BUDGET_BYTES defaults to 1048576 (1.0 MiB raw). The current
#   ~1.77 MiB entry chunk is expected to drop below this after the
#   planned optimization (additional manualChunks splits and/or
#   dynamic import()s of heavy renderer modules). Override via the
#   ENTRY_BUDGET_BYTES env var if you intentionally relax it.

set -euo pipefail

EXPECT_ISSUE=0
ENTRY_BUDGET_BYTES="${ENTRY_BUDGET_BYTES:-1048576}"
MAJOR_CHUNK_MIN_BYTES="${MAJOR_CHUNK_MIN_BYTES:-51200}"
SKIP_BUILD="${SKIP_BUILD:-0}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue         PASS only if the entry chunk EXCEEDS
                         ENTRY_BUDGET_BYTES (baseline mode that confirms
                         the regression exists today).
  --skip-build           Reuse an existing packages/ui/dist build instead
                         of rebuilding (faster local iteration).
  -h, --help             Show this help.

Environment overrides:
  ENTRY_BUDGET_BYTES     Entry chunk raw-byte budget. Default: 1048576
                         (1.0 MiB).
  MAJOR_CHUNK_MIN_BYTES  Raw-byte threshold for listing non-entry chunks
                         alongside the entry chunk. Default: 51200
                         (50 KiB).
  SKIP_BUILD=1           Same as --skip-build.
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue)        EXPECT_ISSUE=1 ;;
    --skip-build)          SKIP_BUILD=1 ;;
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
  echo "repro: building @invoker/ui..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/ui build >/dev/null)
fi

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "repro: missing $ASSETS_DIR -- build failed or output moved" >&2
  exit 1
fi
if [[ ! -f "$INDEX_HTML" ]]; then
  echo "repro: missing $INDEX_HTML -- cannot identify the entry chunk" >&2
  exit 1
fi

EXPECT_ISSUE="$EXPECT_ISSUE" \
ENTRY_BUDGET_BYTES="$ENTRY_BUDGET_BYTES" \
MAJOR_CHUNK_MIN_BYTES="$MAJOR_CHUNK_MIN_BYTES" \
DIST_DIR="$DIST_DIR" \
ASSETS_DIR="$ASSETS_DIR" \
INDEX_HTML="$INDEX_HTML" \
python3 - <<'PY'
import gzip
import os
import re
import sys
from pathlib import Path

dist_dir = Path(os.environ["DIST_DIR"])
assets_dir = Path(os.environ["ASSETS_DIR"])
index_html = Path(os.environ["INDEX_HTML"])
entry_budget = int(os.environ["ENTRY_BUDGET_BYTES"])
major_min = int(os.environ["MAJOR_CHUNK_MIN_BYTES"])
expect_issue = os.environ.get("EXPECT_ISSUE", "0") == "1"

html_text = index_html.read_text(encoding="utf-8")
matches = re.findall(
    r'<script[^>]*\btype="module"[^>]*\bsrc="([^"]+)"',
    html_text,
)
if not matches:
    print(
        "repro: no <script type=\"module\"> tag found in index.html; "
        "cannot identify the entry chunk",
        file=sys.stderr,
    )
    sys.exit(1)

entry_rel = matches[0]
# Vite emits `./assets/index-<hash>.js` (base: './') -- normalize.
entry_rel = entry_rel.lstrip("/").removeprefix("./")
entry_file = dist_dir / entry_rel
if not entry_file.is_file():
    print(
        f"repro: resolved entry chunk {entry_file} does not exist",
        file=sys.stderr,
    )
    sys.exit(1)


def gzip_size(path: Path) -> int:
    with open(path, "rb") as fh:
        return len(gzip.compress(fh.read(), compresslevel=9))


def human(n: int) -> str:
    value = float(n)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if value < 1024 or unit == "GiB":
            if unit == "B":
                return f"{int(value)} B"
            return f"{value:.2f} {unit}"
        value /= 1024
    return f"{n} B"


chunks = []
for path in sorted(assets_dir.glob("*.js")):
    raw = path.stat().st_size
    gz = gzip_size(path)
    chunks.append((path, raw, gz))

entry_raw = entry_file.stat().st_size
entry_gz = gzip_size(entry_file)

print("repro-summary:")
print(f"  entry chunk     : {entry_file.name}")
print(f"    raw           : {entry_raw} B ({human(entry_raw)})")
print(f"    gzip          : {entry_gz} B ({human(entry_gz)})")
print(f"  budget (raw)    : {entry_budget} B ({human(entry_budget)})")
print(
    "  major non-entry chunks "
    f"(raw >= {major_min} B / {human(major_min)}):"
)
others = [
    (p, raw, gz) for (p, raw, gz) in chunks
    if p != entry_file and raw >= major_min
]
others.sort(key=lambda t: t[1], reverse=True)
if not others:
    print("    <none>")
for p, raw, gz in others:
    print(
        f"    - {p.name}: raw={raw} B ({human(raw)}), "
        f"gzip={gz} B ({human(gz)})"
    )

over_budget = entry_raw > entry_budget

if expect_issue:
    if over_budget:
        print(
            "repro: PASS (--expect-issue) -- entry chunk "
            f"{entry_raw} B ({human(entry_raw)}) exceeds budget "
            f"{entry_budget} B ({human(entry_budget)})"
        )
        sys.exit(0)
    print(
        "repro: FAIL (--expect-issue) -- entry chunk "
        f"{entry_raw} B ({human(entry_raw)}) is within budget "
        f"{entry_budget} B ({human(entry_budget)}); the regression "
        "appears to be already fixed",
        file=sys.stderr,
    )
    sys.exit(1)

if over_budget:
    print(
        "repro: FAIL -- entry chunk "
        f"{entry_raw} B ({human(entry_raw)}) exceeds budget "
        f"{entry_budget} B ({human(entry_budget)})",
        file=sys.stderr,
    )
    sys.exit(1)

print(
    "repro: PASS -- entry chunk "
    f"{entry_raw} B ({human(entry_raw)}) is within budget "
    f"{entry_budget} B ({human(entry_budget)})"
)
sys.exit(0)
PY
