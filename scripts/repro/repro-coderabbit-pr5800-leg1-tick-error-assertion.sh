#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr5800-leg1-assert.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- output -----" >&2
    printf '%s\n' "$2" >&2
  fi
  exit 1
}

ROOT="$ROOT" TMP="$TMP" python3 - <<'PY'
from pathlib import Path
import os, re, sys

root = Path(os.environ['ROOT'])
tmp = Path(os.environ['TMP'])
source = (root / 'scripts/repro/worker-routing-driver.mjs').read_text()
start = source.index('// Leg 1: merge conflict -> pr-conflict-rebase worker')
block_start = source.index('{', start)
scan = block_start
depth = 0
block_end = None
while scan < len(source):
    ch = source[scan]
    if ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            block_end = scan
            break
    scan += 1
if block_end is None:
    raise SystemExit('could not isolate leg 1 block')
leg1 = source[block_start:block_end + 1]
js = f"""
const join = (...parts) => parts.join('/');
const writeFileSync = () => {{}};
function makeLeg(kind) {{
  return {{
    kind,
    legDir: '/tmp/leg',
    lines: ['[worker:pr-conflict-rebase] spawning scripts/cron-pr-conflict-rebase.sh'],
  }};
}}
async function tickWorker() {{
  return new Error('boom after dispatch');
}}
const createPrConflictRebaseWorker = {{}};
function assert(leg, ok, what) {{
  if (!ok) throw new Error(what);
}}
const has = (leg, needle) => leg.lines.some((line) => line.includes(needle));
const nodeLogText = () => 'rebase-recreate wf-routing-1';
(async () => {leg1})().catch((err) => {{
  console.error(err.message);
  process.exit(1);
}});
"""
(tmp / 'leg1-check.mjs').write_text(js)
PY

set +e
output="$(node "$TMP/leg1-check.mjs" 2>&1)"
status=$?
set -e

[ "$status" -ne 0 ] || fail "leg 1 passed despite tickWorker returning an error" "$output"
printf '%s' "$output" | grep -Fq "entrypoint completed cleanly" \
  || fail "expected leg 1 to fail on the returned tickWorker error" "$output"

echo "[repro] PASS: leg 1 rejects tickWorker errors before later assertions"
