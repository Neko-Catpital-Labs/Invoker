#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

python3 - <<'PY'
from pathlib import Path
import sys

main_ts = Path('packages/app/src/main.ts')
text = main_ts.read_text()
start_marker = 'async function loadGeneratedPlanPreview(planText: string)'
end_marker = "registerGuiMutationHandler('invoker:plan-from-goal'"
start = text.find(start_marker)
end = text.find(end_marker, start)
if start == -1 or end == -1:
    print('FAIL: could not locate plan-from-goal preview loader in packages/app/src/main.ts')
    sys.exit(1)
body = text[start:end]
if 'taskHandles.clear()' in body:
    print('FAIL: plan-from-goal preview loader clears live task handles')
    sys.exit(1)
print('PASS: plan-from-goal preview loader leaves live task handles intact')
PY
