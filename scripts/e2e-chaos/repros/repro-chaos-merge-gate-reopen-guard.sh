#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

echo "Repro: conflict chaos case must fail before CI flip when merge gate never reopens"
TARGET="scripts/e2e-chaos/cases/case-pr-babysit-conflict.sh"
python3 - "$TARGET" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
required = [
    'GATE_REOPENED=0',
    'GATE_REOPENED=1',
    '[ "$GATE_REOPENED" -eq 1 ] || fail "merge gate did not reopen after conflict repair"',
    'touch "$MARKER_ROOT/pr-ci-failed"',
]
missing = [item for item in required if item not in text]
if missing:
    print('FAIL: chaos case can still flip PR to CI-FAILED without proving gate reopen')
    for item in missing:
        print(f'missing: {item}')
    raise SystemExit(1)

guard_pos = text.index(required[2])
touch_pos = text.index(required[3])
if guard_pos > touch_pos:
    print('FAIL: gate reopen guard runs after the CI failure marker')
    raise SystemExit(1)

print('PASS: chaos case blocks CI failure until the merge gate reopens')
PY
