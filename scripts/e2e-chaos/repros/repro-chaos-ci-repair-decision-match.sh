#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

echo "Repro: ci-failure decision check must reject unrelated worker decisions"
TARGET="scripts/e2e-chaos/cases/case-pr-babysit-conflict.sh"
python3 - "$TARGET" <<'PY'
from pathlib import Path
import json
import re
import subprocess
import sys

text = Path(sys.argv[1]).read_text()
match = re.search(r'python3 - "\$WF_ID" "\$MERGE_ID" "\$DECISIONS_JSON" <<\'PY\'\n(.*?)\nPY', text, re.S)
if not match:
    print('FAIL: case no longer parses worker-decisions JSON for the ci-failure assertion')
    raise SystemExit(1)

script = match.group(1)
workflow_id = 'wf-current'
task_id = '__merge__/wf-current'

unrelated = json.dumps([{
    'decision': 'act',
    'workflowId': 'wf-other',
    'taskId': '__merge__/wf-other',
    'workerKind': 'ci-failure',
    'actionType': 'fix-ci-failure',
    'intentId': '7',
}])
wrong = subprocess.run(
    ['python3', '-c', script, workflow_id, task_id, unrelated],
    check=False,
    capture_output=True,
    text=True,
)
if wrong.returncode == 0:
    print('FAIL: unrelated ci-failure decision still satisfies the assertion')
    raise SystemExit(1)

matching = json.dumps([
    {
        'decision': 'act',
        'workflowId': 'wf-other',
        'taskId': '__merge__/wf-other',
        'workerKind': 'ci-failure',
        'actionType': 'fix-ci-failure',
        'intentId': '7',
    },
    {
        'decision': 'act',
        'workflowId': workflow_id,
        'taskId': task_id,
        'workerKind': 'ci-failure',
        'actionType': 'fix-ci-failure',
        'intentId': '42',
    },
])
good = subprocess.run(
    ['python3', '-c', script, workflow_id, task_id, matching],
    check=False,
    capture_output=True,
    text=True,
)
if good.returncode != 0:
    print('FAIL: matching ci-failure repair decision does not satisfy the assertion')
    if good.stderr:
        print(good.stderr.strip())
    raise SystemExit(1)

print('PASS: ci-failure assertion requires the current workflow/task repair decision')
PY
