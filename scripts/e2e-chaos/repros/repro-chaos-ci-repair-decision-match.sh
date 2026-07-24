#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

echo "Repro: ci-failure decision check must reject unrelated or non-fix-with-agent decisions"
TARGET="scripts/e2e-chaos/cases/case-pr-babysit-conflict.sh"
python3 - "$TARGET" <<'PY'
from pathlib import Path
import json
import re
import subprocess
import sys

text = Path(sys.argv[1]).read_text()
match = re.search(
    r'python3 - "\$WF_ID" "\$MERGE_ID" "\$ACTIONS_JSON" <<\'PY\'\n(.*?)\nPY',
    text,
    re.S,
)
if not match:
    print('FAIL: case no longer parses worker-actions JSON for the ci-failure assertion')
    raise SystemExit(1)

script = match.group(1)
workflow_id = 'wf-current'
task_id = '__merge__/wf-current'


def run(actions):
    return subprocess.run(
        ['python3', '-c', script, workflow_id, task_id, json.dumps(actions)],
        check=False,
        capture_output=True,
        text=True,
    )


def action(**overrides):
    base = {
        'status': 'queued',
        'decision': 'act',
        'workflowId': workflow_id,
        'taskId': task_id,
        'workerKind': 'ci-failure',
        'actionType': 'fix-ci-failure',
        'intentId': '42',
        'payload': {'channel': 'invoker:fix-with-agent'},
    }
    base.update(overrides)
    return base


unrelated = action(workflowId='wf-other', taskId='__merge__/wf-other', intentId='7')
if run([unrelated]).returncode == 0:
    print('FAIL: unrelated ci-failure decision still satisfies the assertion')
    raise SystemExit(1)

wrong_channel = action(payload={'channel': 'invoker:rebase-recreate'}, intentId='41')
if run([wrong_channel]).returncode == 0:
    print('FAIL: a matching decision whose intent is not invoker:fix-with-agent still satisfies the assertion')
    raise SystemExit(1)

skipped = action(status='skipped', decision='skip', intentId=None)
if run([skipped]).returncode == 0:
    print('FAIL: a skipped ci-failure decision still satisfies the assertion')
    raise SystemExit(1)

good = run([unrelated, wrong_channel, skipped, action()])
if good.returncode != 0:
    print('FAIL: matching invoker:fix-with-agent repair decision does not satisfy the assertion')
    if good.stderr:
        print(good.stderr.strip())
    raise SystemExit(1)

print("PASS: ci-failure assertion requires this workflow's invoker:fix-with-agent repair decision")
PY
