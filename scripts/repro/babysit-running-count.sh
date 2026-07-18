#!/usr/bin/env bash
# Sample Invoker queue runningCount for TARGET over DURATION_S seconds.
# Exit 0 if every sample is >= TARGET; exit 1 otherwise (prints BELOW samples).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

TARGET="${1:-12}"
DURATION_S="${2:-300}"
INTERVAL_S="${3:-30}"
OUT="${4:-/tmp/invoker-babysit-samples.jsonl}"
: >"$OUT"

python3 - "$TARGET" "$DURATION_S" "$INTERVAL_S" "$OUT" <<'PY'
import json, re, subprocess, sys, time, datetime
from pathlib import Path

target = int(sys.argv[1])
duration_s = int(sys.argv[2])
interval_s = int(sys.argv[3])
out = Path(sys.argv[4])

def query_queue():
    p = subprocess.run(
        ['./run.sh', '--headless', 'query', 'queue', '--output', 'json'],
        capture_output=True, text=True, timeout=60,
    )
    raw = p.stdout + '\n' + p.stderr
    m = re.search(r'\{"maxConcurrency".*', raw, re.S)
    if not m:
        raise RuntimeError('no queue json: ' + raw[-400:])
    blob = m.group(0)
    depth = 0
    for i, ch in enumerate(blob):
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return json.loads(blob[: i + 1])
    raise RuntimeError('unbalanced json')

start = time.time()
below = False
print(f'babysit: target>={target} for {duration_s}s every {interval_s}s -> {out}', flush=True)
while True:
    elapsed = time.time() - start
    ts = datetime.datetime.utcnow().isoformat() + 'Z'
    try:
        q = query_queue()
        sample = {
            'ts': ts,
            'elapsed_s': round(elapsed, 1),
            'runningCount': q.get('runningCount'),
            'activeExecutionCount': q.get('activeExecutionCount'),
            'launchingCount': q.get('launchingCount'),
            'queuedCount': len(q.get('queued') or []),
            'ok': (q.get('runningCount') or 0) >= target,
            'runningIds': [r['taskId'] for r in q.get('running') or []],
            'queuedIds': [r['taskId'] for r in q.get('queued') or []],
        }
    except Exception as e:
        sample = {'ts': ts, 'elapsed_s': round(elapsed, 1), 'error': str(e), 'ok': False}
        below = True
    out.open('a').write(json.dumps(sample) + '\n')
    status = 'OK' if sample.get('ok') else 'BELOW'
    print(
        f"[{ts}] t+{elapsed:5.0f}s {status} running={sample.get('runningCount')} "
        f"active={sample.get('activeExecutionCount')} launching={sample.get('launchingCount')} "
        f"queued={sample.get('queuedCount')} err={sample.get('error', '')}",
        flush=True,
    )
    if not sample.get('ok'):
        below = True
    if elapsed >= duration_s:
        break
    time.sleep(interval_s)

print('RESULT=' + ('STABLE' if not below else 'FAILED'), flush=True)
sys.exit(0 if not below else 1)
PY
