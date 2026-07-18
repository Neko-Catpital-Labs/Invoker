#!/usr/bin/env bash
# Refill Invoker by recreating failed+pending+running+completed workflows, then starting ready work.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

DRY=()
if [ "${1:-}" = "--dry-run" ]; then
  DRY=(--dry-run)
fi

echo "babysit-refill: start-ready --recreate-all ${DRY[*]:-} --no-track"
./run.sh --headless start-ready --recreate-all "${DRY[@]}" --no-track
echo "babysit-refill: queue snapshot"
./run.sh --headless query queue --output json 2>/tmp/babysit-refill.err >/tmp/babysit-refill.out || true
python3 - <<'PY'
import re, json
from pathlib import Path
raw = Path('/tmp/babysit-refill.out').read_text() + '\n' + Path('/tmp/babysit-refill.err').read_text()
m = re.search(r'\{"maxConcurrency".*', raw, re.S)
if not m:
    print(raw[-800:])
    raise SystemExit(1)
blob = m.group(0)
depth = 0
for i, ch in enumerate(blob):
    if ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            q = json.loads(blob[: i + 1])
            break
print(
    f"running={q.get('runningCount')} active={q.get('activeExecutionCount')} "
    f"launching={q.get('launchingCount')} queued={len(q.get('queued') or [])} "
    f"max={q.get('maxConcurrency')}"
)
PY
