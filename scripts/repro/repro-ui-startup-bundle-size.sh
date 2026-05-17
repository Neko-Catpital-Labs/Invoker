#!/usr/bin/env bash
set -euo pipefail

# Deterministic repro for the oversized renderer entry chunk produced by
# `pnpm --filter @invoker/ui build`.
#
# The current production build emits a single ~1.77 MB entry chunk
# (dist/assets/index-<hash>.js) because @xyflow/react, elkjs, xterm, js-yaml,
# the workflow-graph layer, and the whole React component tree are pulled into
# the synchronous entry. That chunk has to be parsed and evaluated before any
# first paint, which is a plausible cold-start risk separate from graph
# layout. Vite already prints a "chunks > 500 kB" warning but the warning text
# is easy to ignore in CI, so this script enforces an explicit byte budget.
#
# Usage:
#   scripts/repro/repro-ui-startup-bundle-size.sh [--expect-issue] [--budget BYTES]
#
# Modes:
#   --expect-issue   exit 0 when the entry chunk is OVER budget (baseline before
#                    the code-splitting fix), exit 1 if it is already under.
#   default          exit 0 only when the entry chunk is UNDER budget (the
#                    optimized state), exit 1 otherwise.
#
# Always prints:
#   - the resolved entry chunk filename from dist/index.html
#   - raw and gzip sizes for the entry chunk and every other dist/assets/*.js
#   - the configured raw + gzip budgets and a pass/fail line for the entry chunk

# Documented entry-chunk budgets. Picked so the current 1,774,288 B raw entry
# (541,862 B gzip) clearly exceeds the limit, while a reasonable lazy-loading
# split of @xyflow/react / xterm / elkjs / js-yaml off the entry can land
# comfortably under both numbers.
ENTRY_RAW_BUDGET_BYTES=1200000   # 1.20 MB raw
ENTRY_GZIP_BUDGET_BYTES=400000   #   400 KB gzip

EXPECT_ISSUE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    --budget) ENTRY_RAW_BUDGET_BYTES="$2"; shift 2 ;;
    --gzip-budget) ENTRY_GZIP_BUDGET_BYTES="$2"; shift 2 ;;
    -h|--help)
      sed -n '3,/^ENTRY_RAW_BUDGET_BYTES=/p' "$0" | sed 's/^# \?//' | sed '$d'
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UI_DIR="$ROOT_DIR/packages/ui"
ASSETS_DIR="$UI_DIR/dist/assets"
INDEX_HTML="$UI_DIR/dist/index.html"

echo "[repro] building @invoker/ui (production)..." >&2
(cd "$ROOT_DIR" && pnpm --filter @invoker/ui build >&2)

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "[repro] missing $ASSETS_DIR after build" >&2
  exit 1
fi
if [[ ! -f "$INDEX_HTML" ]]; then
  echo "[repro] missing $INDEX_HTML after build" >&2
  exit 1
fi

python3 - \
  "$ASSETS_DIR" \
  "$INDEX_HTML" \
  "$ENTRY_RAW_BUDGET_BYTES" \
  "$ENTRY_GZIP_BUDGET_BYTES" \
  "$EXPECT_ISSUE" <<'PY'
import gzip
import os
import re
import sys

assets_dir = sys.argv[1]
index_html_path = sys.argv[2]
raw_budget = int(sys.argv[3])
gzip_budget = int(sys.argv[4])
expect_issue = sys.argv[5] == '1'

with open(index_html_path, 'r', encoding='utf-8') as f:
    index_html = f.read()

# Vite emits a single <script type="module" src="..."> for the entry chunk.
match = re.search(
    r'<script[^>]+type="module"[^>]+src="([^"]+)"',
    index_html,
)
if not match:
    print('[repro] failed to find entry <script type="module"> in dist/index.html',
          file=sys.stderr)
    sys.exit(1)

entry_href = match.group(1)
entry_filename = os.path.basename(entry_href)
entry_path = os.path.join(assets_dir, entry_filename)
if not os.path.isfile(entry_path):
    print(f'[repro] entry chunk {entry_filename} not present in {assets_dir}',
          file=sys.stderr)
    sys.exit(1)

def sizes(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    return len(data), len(gzip.compress(data, compresslevel=9))

def fmt(bytes_):
    if bytes_ >= 1024 * 1024:
        return f'{bytes_/1024/1024:.2f} MB'
    if bytes_ >= 1024:
        return f'{bytes_/1024:.2f} KB'
    return f'{bytes_} B'

js_files = sorted(
    name for name in os.listdir(assets_dir) if name.endswith('.js')
)

rows = []
for name in js_files:
    raw, gz = sizes(os.path.join(assets_dir, name))
    rows.append((name, raw, gz))

print('repro-summary:')
print(f'  entry_chunk: {entry_filename}')
print(f'  entry_raw_budget_bytes: {raw_budget} ({fmt(raw_budget)})')
print(f'  entry_gzip_budget_bytes: {gzip_budget} ({fmt(gzip_budget)})')
print('  chunks:')
name_width = max((len(n) for n, _, _ in rows), default=0)
for name, raw, gz in rows:
    marker = ' <-- entry' if name == entry_filename else ''
    print(f'    {name.ljust(name_width)}  raw={raw:>10} ({fmt(raw):>9})  '
          f'gzip={gz:>9} ({fmt(gz):>9}){marker}')

entry_raw, entry_gz = sizes(entry_path)
over_raw = entry_raw > raw_budget
over_gzip = entry_gz > gzip_budget
over_budget = over_raw or over_gzip

print(f'  entry_chunk_raw_bytes: {entry_raw} ({fmt(entry_raw)})')
print(f'  entry_chunk_gzip_bytes: {entry_gz} ({fmt(entry_gz)})')
print(f'  entry_chunk_over_raw_budget: {over_raw}')
print(f'  entry_chunk_over_gzip_budget: {over_gzip}')

if expect_issue:
    if over_budget:
        print('repro: PASS (--expect-issue) — entry chunk exceeds documented budget')
        sys.exit(0)
    print('repro: FAIL (--expect-issue) — entry chunk is already within budget; '
          'baseline no longer reproduces')
    sys.exit(1)
else:
    if not over_budget:
        print('repro: PASS — entry chunk is within documented budget')
        sys.exit(0)
    print('repro: FAIL — entry chunk exceeds documented budget after the fix')
    sys.exit(1)
PY
