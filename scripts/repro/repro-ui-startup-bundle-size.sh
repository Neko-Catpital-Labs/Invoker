#!/usr/bin/env bash
#
# Deterministic repro for the oversized @invoker/ui production entry chunk.
#
# The production UI build currently emits a single ~1.77 MB entry chunk
# (`dist/assets/index-*.js`). That much JavaScript has to be fetched,
# parsed, and evaluated before the first React render — a plausible
# cold-start risk that is independent of workflow-graph layout cost. Vite
# prints a generic "chunks larger than 500 kB" warning, but warnings are
# easy to ignore and have no exit-code consequences. This script enforces
# an explicit, repo-local budget that fails CI when the entry chunk grows
# past the configured threshold.
#
# What it does:
#   1. Runs `pnpm --filter @invoker/ui build` to produce a fresh bundle.
#   2. Inspects `packages/ui/dist/assets/`, identifying the entry chunk
#      (`index-*.js`) and every other JS chunk.
#   3. Prints raw and gzip sizes for the entry chunk and each major chunk.
#   4. Compares the entry chunk's raw size against ENTRY_BUDGET_BYTES.
#
# Modes:
#   --expect-issue   PASS when the entry chunk EXCEEDS the budget
#                    (confirms the bloat exists today, before the fix).
#   (default)        PASS only when the entry chunk is UNDER the budget
#                    (validates the optimization after the fix).
#
# Budget rationale:
#   Today's entry chunk is ~1,773,923 bytes. A 900,000-byte (≈879 KiB)
#   budget gives the optimization a concrete target (~½ of current size)
#   while leaving headroom for genuine new features. Override with the
#   ENTRY_BUDGET_BYTES env var if a different threshold is needed.

set -euo pipefail

EXPECT_ISSUE=0
ENTRY_BUDGET_BYTES="${ENTRY_BUDGET_BYTES:-900000}"
MAJOR_CHUNK_MIN_BYTES="${MAJOR_CHUNK_MIN_BYTES:-50000}"
SKIP_BUILD="${SKIP_BUILD:-0}"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --expect-issue              PASS only if the @invoker/ui entry chunk
                              EXCEEDS ENTRY_BUDGET_BYTES (baseline mode,
                              used to confirm the bloat before the fix).
  --entry-budget-bytes N      Raw-byte budget for the entry chunk
                              (default: ${ENTRY_BUDGET_BYTES}).
  --major-chunk-min-bytes N   Threshold for listing a chunk as "major"
                              in the report (default: ${MAJOR_CHUNK_MIN_BYTES}).
  --skip-build                Skip running the UI build; reuse whatever
                              is already in packages/ui/dist/assets/.
  -h, --help                  Show this help.

Env overrides:
  ENTRY_BUDGET_BYTES, MAJOR_CHUNK_MIN_BYTES, SKIP_BUILD
EOF
}

while (( $# )); do
  case "$1" in
    --expect-issue)             EXPECT_ISSUE=1 ;;
    --entry-budget-bytes)       shift; ENTRY_BUDGET_BYTES="$1" ;;
    --entry-budget-bytes=*)     ENTRY_BUDGET_BYTES="${1#*=}" ;;
    --major-chunk-min-bytes)    shift; MAJOR_CHUNK_MIN_BYTES="$1" ;;
    --major-chunk-min-bytes=*)  MAJOR_CHUNK_MIN_BYTES="${1#*=}" ;;
    --skip-build)               SKIP_BUILD=1 ;;
    -h|--help)                  usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ASSETS_DIR="$REPO_ROOT/packages/ui/dist/assets"

if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "repro: building @invoker/ui..."
  (cd "$REPO_ROOT" && pnpm --filter @invoker/ui build >/dev/null)
else
  echo "repro: --skip-build set; reusing existing $ASSETS_DIR"
fi

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "repro: FAIL -- $ASSETS_DIR does not exist after build" >&2
  exit 1
fi

EXPECT_ISSUE="$EXPECT_ISSUE" \
ENTRY_BUDGET_BYTES="$ENTRY_BUDGET_BYTES" \
MAJOR_CHUNK_MIN_BYTES="$MAJOR_CHUNK_MIN_BYTES" \
ASSETS_DIR="$ASSETS_DIR" \
python3 - <<'PY'
import gzip
import os
import re
import sys
from pathlib import Path

assets_dir = Path(os.environ["ASSETS_DIR"])
expect_issue = os.environ.get("EXPECT_ISSUE", "0") == "1"
entry_budget = int(os.environ["ENTRY_BUDGET_BYTES"])
major_min = int(os.environ["MAJOR_CHUNK_MIN_BYTES"])

js_files = sorted(p for p in assets_dir.iterdir() if p.is_file() and p.suffix == ".js")
if not js_files:
    print(f"repro: FAIL -- no JS chunks found in {assets_dir}", file=sys.stderr)
    sys.exit(1)


def human(n: int) -> str:
    if n >= 1024 * 1024:
        return f"{n / (1024 * 1024):.2f} MiB"
    if n >= 1024:
        return f"{n / 1024:.2f} KiB"
    return f"{n} B"


def gzip_size(path: Path) -> int:
    with path.open("rb") as fh:
        return len(gzip.compress(fh.read(), compresslevel=6))


# Vite emits the entry as `index-<hash>.js` by default. Pick the largest
# match so a stray `index-foo.js` from a future split doesn't fool us.
entry_pattern = re.compile(r"^index-[A-Za-z0-9_-]+\.js$")
entry_candidates = [p for p in js_files if entry_pattern.match(p.name)]
if not entry_candidates:
    print(
        "repro: FAIL -- no entry chunk matching index-<hash>.js found; "
        f"present files: {[p.name for p in js_files]}",
        file=sys.stderr,
    )
    sys.exit(1)
entry = max(entry_candidates, key=lambda p: p.stat().st_size)

entry_raw = entry.stat().st_size
entry_gz = gzip_size(entry)

print(f"repro: assets dir: {assets_dir}")
print(f"repro: entry chunk: {entry.name}")
print(f"  raw : {entry_raw:>10} bytes ({human(entry_raw)})")
print(f"  gzip: {entry_gz:>10} bytes ({human(entry_gz)})")
print(f"repro: budget (raw): {entry_budget} bytes ({human(entry_budget)})")

print("repro: major chunks (raw >= "
      f"{major_min} bytes, {human(major_min)}):")
majors = [p for p in js_files if p != entry and p.stat().st_size >= major_min]
majors.sort(key=lambda p: p.stat().st_size, reverse=True)
if not majors:
    print("  (none)")
for p in majors:
    raw = p.stat().st_size
    gz = gzip_size(p)
    print(
        f"  - {p.name}: raw={raw} ({human(raw)}), gzip={gz} ({human(gz)})"
    )

minors = [p for p in js_files if p != entry and p.stat().st_size < major_min]
if minors:
    print("repro: minor JS chunks (below threshold):")
    for p in sorted(minors, key=lambda p: p.stat().st_size, reverse=True):
        raw = p.stat().st_size
        print(f"  - {p.name}: raw={raw} ({human(raw)})")

over_budget = entry_raw > entry_budget

if expect_issue:
    if over_budget:
        print(
            f"repro: PASS (--expect-issue) -- entry chunk {entry_raw} bytes "
            f"exceeds budget {entry_budget} bytes (bloat confirmed)"
        )
        sys.exit(0)
    print(
        f"repro: FAIL (--expect-issue) -- entry chunk {entry_raw} bytes is "
        f"already within budget {entry_budget} bytes; bug appears fixed",
        file=sys.stderr,
    )
    sys.exit(1)

if over_budget:
    print(
        f"repro: FAIL -- entry chunk {entry_raw} bytes exceeds budget "
        f"{entry_budget} bytes ({entry_raw - entry_budget} bytes over)",
        file=sys.stderr,
    )
    sys.exit(1)

print(
    f"repro: PASS -- entry chunk {entry_raw} bytes is within budget "
    f"{entry_budget} bytes ({entry_budget - entry_raw} bytes of headroom)"
)
sys.exit(0)
PY
