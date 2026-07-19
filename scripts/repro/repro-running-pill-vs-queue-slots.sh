#!/usr/bin/env bash
# Prove UI "workflows running (N)" is a workflow-status count, not queue slots.
# Historical confusion: chip said "Running (14)" next to "Executing 13/13" + "Queued (4)".
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

python3 <<'PY'
import json, re, subprocess, sys

def run(args):
    p = subprocess.run(
        ["node", "./packages/app/dist/headless-client.js", *args],
        capture_output=True, text=True, timeout=120,
    )
    raw = p.stdout + "\n" + p.stderr
    if "mode=gui" not in raw and "ownerId=" not in raw:
        # Still OK if stdout is pure JSON from delegated path with quiet logs
        pass
    if "spawning detached standalone" in raw or "[init] Loaded" in raw:
        print("FAIL opened local DB / bootstrapped standalone instead of GUI owner", flush=True)
        sys.exit(2)
    return raw, p.returncode

raw_q, code = run(["query", "queue", "--output", "json"])
if code != 0:
    print(raw_q[-500:])
    sys.exit(code)
m = re.search(r'\{"maxConcurrency".*', raw_q, re.S)
blob = m.group(0)
depth = 0
q = None
for i, ch in enumerate(blob):
    if ch == "{":
        depth += 1
    elif ch == "}":
        depth -= 1
        if depth == 0:
            q = json.loads(blob[: i + 1])
            break
assert q is not None

raw_w, code = run(["query", "workflows", "--output", "json"])
if code != 0:
    print(raw_w[-500:])
    sys.exit(code)
arr_i = raw_w.find("[")
workflows = json.loads(raw_w[arr_i:])
wf_running = sum(1 for w in workflows if w.get("status") == "running")

slots = q["runningCount"]
active = q.get("activeExecutionCount")
launching = q.get("launchingCount")
queued = len(q.get("queued") or [])

print(json.dumps({
    "workflow_pill_running": wf_running,
    "queue_slots_runningCount": slots,
    "queue_activeExecutionCount": active,
    "queue_launchingCount": launching,
    "queue_queued": queued,
    "mismatch_workflow_vs_slots": wf_running != slots,
    "mismatch_slots_vs_active": slots != active,
}, indent=2), flush=True)

if active is None or launching is None:
    print("FAIL missing active/launching fields", flush=True)
    sys.exit(3)
if active + launching != slots:
    print(f"FAIL identity {active}+{launching} != {slots}", flush=True)
    sys.exit(4)

if wf_running != slots or slots != active:
    print(
        "REPRO_CONFIRMED distinct_metrics: "
        "workflows running pill counts workflows; "
        "Executing/Slots chips count task attempts; "
        "Queued is ready-but-not-slotted tasks",
        flush=True,
    )
else:
    print("NOTE all three metrics currently equal (no mismatch visible)", flush=True)
print("OK", flush=True)
PY
