#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "Repro: owner-serve must expose the web surface only after workers and the dispatcher are ready"

ROOT="$ROOT" python3 - <<'PY'
from pathlib import Path
import os
import sys

source = (Path(os.environ['ROOT']) / 'packages/app/src/main.ts').read_text()

needles = {
    'owner-serve guard': "if (command === 'owner-serve') {",
    'worker auto-start': 'workerRuntimeController.startAutoStartedWorkers();',
    'launch dispatcher': 'standaloneLaunchDispatcherController = startStandaloneLaunchDispatcher({',
    'web surface startup': 'headlessWebBridge = startWebSurfaceForHeadless(',
    'idle loop': 'await runHeadless(cliArgs, headlessDeps);',
}

positions = {}
for label, needle in needles.items():
    idx = source.find(needle)
    if idx < 0:
        print(f"[repro] FAIL: missing {label}: {needle}", file=sys.stderr)
        raise SystemExit(1)
    positions[label] = idx

guard_open = source.find('{', positions['owner-serve guard'])
if guard_open < 0:
    print('[repro] FAIL: owner-serve guard opening brace not found', file=sys.stderr)
    raise SystemExit(1)

depth = 0
guard_close = -1
for idx in range(guard_open, len(source)):
    ch = source[idx]
    if ch == '{':
        depth += 1
    elif ch == '}':
        depth -= 1
        if depth == 0:
            guard_close = idx
            break

if guard_close < 0:
    print('[repro] FAIL: owner-serve guard closing brace not found', file=sys.stderr)
    raise SystemExit(1)

web_idx = positions['web surface startup']
if not positions['owner-serve guard'] < web_idx < guard_close:
    print('[repro] FAIL: owner-serve web surface startup escaped its guard', file=sys.stderr)
    raise SystemExit(1)
if not positions['worker auto-start'] < web_idx:
    print('[repro] FAIL: web surface starts before worker auto-start', file=sys.stderr)
    raise SystemExit(1)
if not positions['launch dispatcher'] < web_idx:
    print('[repro] FAIL: web surface starts before launch dispatcher initialization', file=sys.stderr)
    raise SystemExit(1)
if not web_idx < positions['idle loop']:
    print('[repro] FAIL: web surface does not start before entering the idle loop', file=sys.stderr)
    raise SystemExit(1)

print('[repro] PASS: owner-serve web surface starts inside the guard after workers and dispatcher')
PY
