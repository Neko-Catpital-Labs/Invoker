#!/usr/bin/env bash
# Supervise GUI owner + keep runningCount near maxConcurrency via start-ready --recreate-all.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

TARGET="${1:-12}"
DURATION_S="${2:-600}"
INTERVAL_S="${3:-30}"
OUT="${4:-/tmp/invoker-capacity-supervisor.jsonl}"
: >"$OUT"
: > /tmp/invoker-gui.log

python3 - "$TARGET" "$DURATION_S" "$INTERVAL_S" "$OUT" <<'PY'
import json, re, subprocess, sys, time, datetime
from pathlib import Path

target = int(sys.argv[1])
duration_s = int(sys.argv[2])
interval_s = int(sys.argv[3])
out = Path(sys.argv[4])
root = Path.cwd()

def run(cmd, timeout=420, cwd=None):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd or root)

def gui_procs():
    p = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True)
    return [
        l for l in p.stdout.splitlines()
        if 'packages/app/dist/main.js' in l and 'headless' not in l
    ]

def standalone_procs():
    p = subprocess.run(['ps', '-axo', 'pid=,command='], capture_output=True, text=True)
    return [l for l in p.stdout.splitlines() if 'owner-serve' in l]

def extract_obj(raw, prefix='{"maxConcurrency"'):
    m = re.search(re.escape(prefix) + r'.*', raw, re.S)
    if not m:
        return None
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

def ensure_gui():
    if gui_procs() and not standalone_procs():
        # confirm ping
        p = run(['./run.sh', '--headless', 'query', 'stats', '--output', 'json'], timeout=90)
        raw = p.stdout + '\n' + p.stderr
        if 'mode=gui' in raw and 'spawning detached standalone' not in raw:
            return True
    print('RESTART_GUI', flush=True)
    run(['./scripts/kill-all-electron.sh'], timeout=60)
    time.sleep(1)
    Path('/tmp/invoker-gui.log').write_text('')
    subprocess.Popen(
        ['./run.sh'],
        cwd=str(root),
        stdout=open('/tmp/invoker-gui.log', 'a'),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.time() + 480
    while time.time() < deadline:
        if gui_procs():
            p = run(['./run.sh', '--headless', 'query', 'stats', '--output', 'json'], timeout=90)
            raw = p.stdout + '\n' + p.stderr
            if 'spawning detached standalone' in raw:
                print('ABORT_STANDALONE_DURING_START', flush=True)
                run(['./scripts/kill-all-electron.sh'], timeout=60)
                time.sleep(2)
                continue
            if 'mode=gui' in raw:
                print('GUI_READY', flush=True)
                return True
        time.sleep(6)
    print('GUI_START_TIMEOUT', flush=True)
    return False

def query_queue():
    p = run(['./run.sh', '--headless', 'query', 'queue', '--output', 'json'], timeout=90)
    raw = p.stdout + '\n' + p.stderr
    mode = 'gui' if 'mode=gui' in raw else ('standalone' if 'mode=standalone' in raw else None)
    if gui_procs() and mode is None:
        mode = 'gui'
    q = extract_obj(raw)
    if q is None:
        raise RuntimeError(raw[-400:])
    return mode, q

def refill():
    if not gui_procs():
        raise RuntimeError('refill refused: no gui process')
    print('REFILL --recreate-all', flush=True)
    try:
        p = run(['./run.sh', '--headless', 'start-ready', '--recreate-all', '--no-track'], timeout=600)
    except subprocess.TimeoutExpired:
        print('REFILL_TIMEOUT', flush=True)
        return 124
    raw = p.stdout + '\n' + p.stderr
    if 'spawning detached standalone' in raw:
        print('REFILL_SPAWNED_STANDALONE', flush=True)
    print('refill_exit', p.returncode, flush=True)
    return p.returncode

start = time.time()
below_samples = 0
ok_samples = 0
print(f'supervisor: target>={target} for {duration_s}s every {interval_s}s -> {out}', flush=True)

while time.time() - start < duration_s:
    ts = datetime.datetime.utcnow().isoformat() + 'Z'
    elapsed = round(time.time() - start, 1)
    if not gui_procs() or standalone_procs():
        if standalone_procs():
            print('KILL_STANDALONE', flush=True)
        if not ensure_gui():
            sample = {'ts': ts, 'elapsed_s': elapsed, 'ok': False, 'error': 'gui-start-failed'}
            out.open('a').write(json.dumps(sample) + '\n')
            time.sleep(interval_s)
            continue
        try:
            refill()
        except Exception as e:
            print('REFILL_FAIL', e, flush=True)

    try:
        mode, q = query_queue()
        running = q.get('runningCount') or 0
        active = q.get('activeExecutionCount') or 0
        launching = q.get('launchingCount') or 0
        queued = len(q.get('queued') or [])
        ok = mode == 'gui' and running >= target
        sample = {
            'ts': ts, 'elapsed_s': elapsed, 'mode': mode,
            'runningCount': running, 'activeExecutionCount': active,
            'launchingCount': launching, 'queuedCount': queued,
            'maxConcurrency': q.get('maxConcurrency'), 'ok': ok,
            'guiProcs': len(gui_procs()),
        }
        if running < target and mode == 'gui':
            sample['refill'] = True
            try:
                sample['refill_exit'] = refill()
            except Exception as e:
                sample['refill_error'] = str(e)
                ok = False
        out.open('a').write(json.dumps(sample) + '\n')
        status = 'OK' if ok else 'BELOW'
        print(
            f'[{ts}] t+{elapsed:5.0f}s {status} mode={mode} running={running} '
            f'active={active} launching={launching} queued={queued} gui={sample["guiProcs"]}',
            flush=True,
        )
        if ok:
            ok_samples += 1
        else:
            below_samples += 1
    except Exception as e:
        out.open('a').write(json.dumps({'ts': ts, 'elapsed_s': elapsed, 'ok': False, 'error': str(e)}) + '\n')
        print(f'[{ts}] ERR {e}', flush=True)
        below_samples += 1
        ensure_gui()
    time.sleep(interval_s)

print(f'RESULT ok_samples={ok_samples} below_samples={below_samples}', flush=True)
sys.exit(0 if below_samples == 0 and ok_samples > 0 else 1)
PY
