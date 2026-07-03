#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

python3 - <<'PY'
from pathlib import Path
import re
import sys

main_ts = Path('packages/app/src/main.ts')
text = main_ts.read_text()
match = re.search(r"registerGuiMutationHandler\('invoker:plan-from-goal',\s*async \(([^)]*)\)", text)
if not match:
    print('FAIL: could not locate invoker:plan-from-goal GUI mutation handler')
    sys.exit(1)
params = match.group(1).strip()
if params != 'request: unknown':
    print(f'FAIL: invoker:plan-from-goal handler parameter is too narrow: ({params})')
    sys.exit(1)
if 'planFromGoalInApp(request as InAppPlanRequest' not in text:
    print('FAIL: handler does not narrow/cast unknown request before calling planFromGoalInApp')
    sys.exit(1)
print('PASS: invoker:plan-from-goal handler accepts unknown input and narrows locally')
PY
