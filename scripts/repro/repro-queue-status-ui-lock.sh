#!/usr/bin/env bash
# Prove owner getQueueStatus used by the UI must stay fast.
# Under load, the old path (topo-sort + uncached attempt SQLite reads + full
# descriptions) blocked Electron main for ~0.5–2s per 2s UI poll → drag lockup.
#
# Gate: with --gate, expect owner-delegated queue query p50 < 0.75s.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

GATE=0
if [ "${1:-}" = "--gate" ]; then GATE=1; fi

python3 - "$GATE" <<'PY'
import json, re, statistics, subprocess, sys, time

gate = sys.argv[1] == "1"

def queue_once():
    t0 = time.time()
    p = subprocess.run(
        ["node", "./packages/app/dist/headless-client.js", "query", "queue", "--output", "json"],
        capture_output=True, text=True, timeout=120,
    )
    dt = time.time() - t0
    raw = p.stdout + "\n" + p.stderr
    if "spawning detached standalone" in raw or "[init] Loaded" in raw:
        raise RuntimeError("local DB / standalone bootstrap — not measuring owner UI path")
    m = re.search(r'\{"maxConcurrency".*', raw, re.S)
    if not m:
        raise RuntimeError("no queue json: " + raw[-400:])
    blob = m.group(0)
    depth = 0
    for i, ch in enumerate(blob):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return dt, json.loads(blob[: i + 1]), ("mode=gui" in raw or "ownerId=" in raw)
    raise RuntimeError("unbalanced")

times = []
last = None
mode_gui = False
for i in range(5):
    dt, obj, mode_gui = queue_once()
    times.append(dt)
    last = obj
    desc_bytes = sum(len(x.get("description") or "") for x in obj.get("running") or [])
    print(
        f"sample[{i}] {dt:.3f}s runningCount={obj['runningCount']} "
        f"active={obj.get('activeExecutionCount')} launching={obj.get('launchingCount')} "
        f"queued={len(obj['queued'])} desc_bytes={desc_bytes} mode_gui={mode_gui}",
        flush=True,
    )

p50 = statistics.median(times)
mx = max(times)
print(f"RESULT p50={p50:.3f}s max={mx:.3f}s", flush=True)
if last:
    ac = last.get("activeExecutionCount") or 0
    lc = last.get("launchingCount") or 0
    rc = last.get("runningCount") or 0
    if ac + lc != rc:
        print(f"FAIL count identity active+launching={ac+lc} runningCount={rc}", flush=True)
        sys.exit(2)
    if len(last["running"]) != rc:
        print(f"FAIL running list len={len(last['running'])} runningCount={rc}", flush=True)
        sys.exit(3)

THRESHOLD = 0.75
if gate:
    if not mode_gui:
        print("GATE_FAIL not talking to GUI owner", flush=True)
        sys.exit(1)
    if p50 > THRESHOLD:
        print(f"GATE_FAIL p50={p50:.3f}s > {THRESHOLD}s (UI poll will hitch)", flush=True)
        sys.exit(1)
    print(f"GATE_PASS p50={p50:.3f}s <= {THRESHOLD}s", flush=True)
else:
    if p50 > THRESHOLD:
        print(f"REPRO_CONFIRMED slow_queue_query p50={p50:.3f}s (expected before fix)", flush=True)
    else:
        print(f"ALREADY_FAST p50={p50:.3f}s", flush=True)
sys.exit(0)
PY
