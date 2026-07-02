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

in_jobs = False
job_names: list[str] = []
for line in lines:
    if line == 'jobs:':
        in_jobs = True
        continue
    if not in_jobs:
        continue
    if line and not line.startswith(' ') and not line.startswith('#'):
        break
    match = re.match(r'^  ([A-Za-z0-9_-]+):(?:\s*)$', line)
    if match:
        job_names.append(match.group(1))

count = job_names.count('dry-run')
if count != 1:
    print(f'[repro] FAIL: expected exactly one top-level jobs.dry-run entry, found {count}')
    sys.exit(1)
print('[repro] PASS: workflow has one surviving jobs.dry-run entry')
PY
