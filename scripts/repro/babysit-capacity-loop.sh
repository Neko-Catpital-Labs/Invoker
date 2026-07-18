#!/usr/bin/env bash
# Continuous capacity babysit: hold runningCount>=TARGET, refill with --recreate-all on drop.
# Exit 0 only after STABLE_WINDOWS consecutive full DURATION_S windows at target.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

TARGET="${1:-12}"
DURATION_S="${2:-300}"
INTERVAL_S="${3:-30}"
STABLE_WINDOWS="${4:-1}"
OUT="${5:-/tmp/invoker-capacity-loop.jsonl}"
: >"$OUT"

python3 - "$TARGET" "$DURATION_S" "$INTERVAL_S" "$STABLE_WINDOWS" "$OUT" <<'PY'
import json, re, subprocess, sys, time, datetime
from pathlib import Path

target = int(sys.argv[1])
duration_s = int(sys.argv[2])
interval_s = int(sys.argv[3])
stable_windows = int(sys.argv[4])
out = Path(sys.argv[5])

def run(cmd, timeout=360):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)

def extract_json_obj(raw, prefix='{"maxConcurrency"'):
    m = re.search(re.escape(prefix) + r'.*', raw, re.S)
    if not m:
        # also try stats-like
        idx = raw.rfind('\n{')
        if idx < 0:
            return None
        blob = raw[idx+1:]
    else:
        blob = m.group(0)
    depth = 0
    for i, ch in enumerate(blob):
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return json.loads(blob[: i + 1])
    return None

def owner_mode():
    """Prefer stats owner-ping; fall back to live GUI Electron process."""
    p = run(['./run.sh', '--headless', 'query', 'stats', '--output', 'json'], timeout=90)
    raw = p.stdout + '\n' + p.stderr
    if 'spawning detached standalone' in raw:
        return 'bootstrap-standalone', raw
    if 'mode=gui' in raw:
        return 'gui', raw
    if 'mode=standalone' in raw and 'mode=gui' not in raw:
        return 'standalone', raw
    ps = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True)
    gui = [
        l for l in ps.stdout.splitlines()
        if 'packages/app/dist/main.js' in l and 'headless' not in l
    ]
    if gui:
        return 'gui', raw
    return None, raw

def query_queue():
    mode, mode_raw = owner_mode()
    p = run(['./run.sh', '--headless', 'query', 'queue', '--output', 'json'], timeout=90)
    raw = p.stdout + '\n' + p.stderr
    if 'spawning detached standalone' in raw:
        mode = 'bootstrap-standalone'
    q = extract_json_obj(raw)
    if q is None:
        raise RuntimeError('no queue json: ' + raw[-500:])
    return mode, q, mode_raw + '\n' + raw

def refill():
    print('REFILL start-ready --recreate-all --no-track', flush=True)
    p = run(['./run.sh', '--headless', 'start-ready', '--recreate-all', '--no-track'], timeout=360)
    raw = p.stdout + '\n' + p.stderr
    interesting = [
        l for l in raw.splitlines()
        if any(k in l for k in [
            'Start and recreate', 'recreated workflows', 'started:', 'timeoutMs=',
            'spawning detached', 'Error', 'Delegated', 'fallthrough', 'timeout',
        ])
    ]
    for l in interesting[-30:]:
        print('  ' + l[:220], flush=True)
    return p.returncode, raw

stable = 0
window = 0
print(
    f'capacity-loop: target>={target} window={duration_s}s interval={interval_s}s '
    f'need_stable_windows={stable_windows} -> {out}',
    flush=True,
)

while stable < stable_windows:
    window += 1
    start = time.time()
    below = False
    print(f'=== WINDOW {window} begin ===', flush=True)
    while True:
        elapsed = time.time() - start
        ts = datetime.datetime.utcnow().isoformat() + 'Z'
        try:
            mode, q, _ = query_queue()
            running = q.get('runningCount') or 0
            sample = {
                'ts': ts,
                'window': window,
                'elapsed_s': round(elapsed, 1),
                'mode': mode,
                'runningCount': running,
                'activeExecutionCount': q.get('activeExecutionCount'),
                'launchingCount': q.get('launchingCount'),
                'queuedCount': len(q.get('queued') or []),
                'maxConcurrency': q.get('maxConcurrency'),
                'ok': running >= target and mode == 'gui',
            }
            if mode != 'gui':
                sample['ok'] = False
                sample['error'] = f'owner_mode={mode}'
                below = True
                out.open('a').write(json.dumps(sample) + '\n')
                print(f'[{ts}] OWNER_BAD mode={mode} — abort window for restart', flush=True)
                sys.exit(2)
        except Exception as e:
            sample = {
                'ts': ts, 'window': window, 'elapsed_s': round(elapsed, 1),
                'error': str(e), 'ok': False,
            }
            below = True
            out.open('a').write(json.dumps(sample) + '\n')
            print(f'[{ts}] QUERY_FAIL {e}', flush=True)
            # attempt refill only if gui might still be up
            try:
                refill()
            except Exception as re:
                print(f'REFILL_FAIL {re}', flush=True)
                sys.exit(3)
            time.sleep(interval_s)
            continue

        if running < target:
            below = True
            sample['refill'] = True
            out.open('a').write(json.dumps(sample) + '\n')
            print(
                f"[{ts}] t+{elapsed:5.0f}s BELOW running={running} "
                f"active={sample['activeExecutionCount']} launching={sample['launchingCount']} "
                f"queued={sample['queuedCount']} -> REFILL",
                flush=True,
            )
            try:
                code, _ = refill()
                print(f'  refill_exit={code}', flush=True)
            except Exception as re:
                print(f'REFILL_FAIL {re}', flush=True)
                sys.exit(3)
        else:
            out.open('a').write(json.dumps(sample) + '\n')
            print(
                f"[{ts}] t+{elapsed:5.0f}s OK running={running} "
                f"active={sample['activeExecutionCount']} launching={sample['launchingCount']} "
                f"queued={sample['queuedCount']}",
                flush=True,
            )

        if elapsed >= duration_s:
            break
        time.sleep(interval_s)

    if below:
        stable = 0
        print(f'=== WINDOW {window} FAILED (had below-target samples) stable={stable} ===', flush=True)
    else:
        stable += 1
        print(f'=== WINDOW {window} STABLE stable={stable}/{stable_windows} ===', flush=True)

print('RESULT=CAPACITY_HELD', flush=True)
sys.exit(0)
PY
