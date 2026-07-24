#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
TARGET="$ROOT/packages/surfaces/src/__tests__/slack-surface-workflows.test.ts"

if [ ! -f "$TARGET" ]; then
  echo "[repro] FAIL: missing target test file at $TARGET"
  exit 1
fi

echo "[repro] problem: oversized workflow assistant prompt test must prove the full task output survives materialization"
echo "[repro] check: the test asserts both the task header and hugeOutput in the spilled prompt file"

python3 - "$TARGET" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
needle = "it('uses a temporary prompt file for oversized workflow assistant context'"
start = text.find(needle)
if start == -1:
    raise SystemExit('[repro] FAIL: target test block not found')
end = text.find("\n  it('", start + len(needle))
block = text[start:] if end == -1 else text[start:end]

required = [
    "const promptContents = readFileSync(promptFile, 'utf8');",
    "expect(promptContents).toContain('Task wf-1-2/api (status=running');",
    "expect(promptContents).toContain(hugeOutput);",
]
missing = [snippet for snippet in required if snippet not in block]
if missing:
    raise SystemExit('[repro] FAIL: missing oversized prompt preservation assertion(s): ' + '; '.join(missing))

print('[repro] PASS: oversized workflow assistant prompt test proves the full task output is preserved')
PY
