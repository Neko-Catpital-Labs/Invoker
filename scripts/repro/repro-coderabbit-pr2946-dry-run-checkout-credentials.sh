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

def job_blocks(job_name: str) -> list[list[str]]:
    blocks: list[list[str]] = []
    for start, line in enumerate(lines):
        if line != f'  {job_name}:':
            continue
        end = len(lines)
        for i in range(start + 1, len(lines)):
            if re.match(r'^  [A-Za-z0-9_-]+:', lines[i]):
                end = i
                break
        blocks.append(lines[start:end])
    return blocks

def checkout_step(block: list[str]) -> list[str]:
    start = None
    for i, line in enumerate(block):
        if line == '      - name: Checkout':
            start = i
            break
    if start is None:
        fail('dry-run has no Checkout step')
    end = len(block)
    for i in range(start + 1, len(block)):
        if block[i].startswith('      - name: '):
            end = i
            break
    return block[start:end]

blocks = job_blocks('dry-run')
if len(blocks) != 1:
    fail(f'expected one jobs.dry-run block before checking credentials, found {len(blocks)}')
step = checkout_step(blocks[0])
if not any(line.strip() == 'uses: actions/checkout@v4' for line in step):
    fail('dry-run Checkout does not use actions/checkout@v4')
if not any(line.strip() == 'fetch-depth: 0' for line in step):
    fail('dry-run Checkout lost fetch-depth: 0')
if not any(line.strip() == 'persist-credentials: false' for line in step):
    fail('dry-run Checkout persists the default GitHub token')
print('[repro] PASS: dry-run checkout disables persisted credentials and keeps full fetch')
PY
