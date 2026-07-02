#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

python3 - <<'PY'
from pathlib import Path
import re
import sys

workflow = Path('.github/workflows/ci.yml')
lines = workflow.read_text().splitlines()

def fail(message: str) -> None:
    print(f'[repro] FAIL: {message}')
    sys.exit(1)

def job_block(job_name: str) -> list[str]:
    start = None
    header = f'  {job_name}:'
    for i, line in enumerate(lines):
        if line == header:
            start = i
            break
    if start is None:
        fail(f'missing jobs.{job_name}')
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if re.match(r'^  [A-Za-z0-9_-]+:', lines[i]):
            end = i
            break
    return lines[start:end]

def checkout_step(block: list[str]) -> list[str]:
    start = None
    for i, line in enumerate(block):
        if line == '      - name: Checkout':
            start = i
            break
    if start is None:
        fail('e2e-proof-aggregate has no Checkout step')
    end = len(block)
    for i in range(start + 1, len(block)):
        if block[i].startswith('      - name: '):
            end = i
            break
    return block[start:end]

step = checkout_step(job_block('e2e-proof-aggregate'))
if not any(line.strip() == 'uses: actions/checkout@v4' for line in step):
    fail('e2e-proof-aggregate Checkout does not use actions/checkout@v4')
if not any(line.strip() == 'persist-credentials: false' for line in step):
    fail('e2e-proof-aggregate Checkout persists the default GitHub token')
print('[repro] PASS: e2e-proof-aggregate checkout disables persisted credentials')
PY
