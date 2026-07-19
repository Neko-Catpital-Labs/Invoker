#!/usr/bin/env bash
# Prove UI "Executing" chip historically used runningCount (slots) which includes launching,
# so Executing != active executions. Gate checks active+launching identity and that
# chip semantics can separate active vs slots.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

python3 <<'PY'
import json, re, subprocess, sys

p = subprocess.run(
    ["node", "./packages/app/dist/headless-client.js", "query", "queue", "--output", "json"],
    capture_output=True, text=True, timeout=120,
)
raw = p.stdout + "\n" + p.stderr
if "spawning detached standalone" in raw or "[init] Loaded" in raw:
    print("FAIL local DB / standalone bootstrap", flush=True)
    sys.exit(2)
m = re.search(r'\{"maxConcurrency".*', raw, re.S)
blob = m.group(0)
depth = 0
for i, ch in enumerate(blob):
    if ch == "{":
        depth += 1
    elif ch == "}":
        depth -= 1
        if depth == 0:
            q = json.loads(blob[: i + 1])
            break

rc = q["runningCount"]
ac = q.get("activeExecutionCount")
lc = q.get("launchingCount")
queued = len(q.get("queued") or [])
print(json.dumps({
    "runningCount_slots": rc,
    "activeExecutionCount": ac,
    "launchingCount": lc,
    "queued": queued,
    "legacy_Executing_chip_would_show": f"{rc}/{q['maxConcurrency']}",
    "correct_Executing_chip_should_show": f"{ac}/{q['maxConcurrency']}",
    "slots_chip_should_show": f"{rc}/{q['maxConcurrency']}",
}, indent=2))

if ac is None or lc is None:
    print("FAIL missing active/launching fields", flush=True)
    sys.exit(2)
if ac + lc != rc:
    print(f"FAIL identity active+launching ({ac}+{lc}) != runningCount ({rc})", flush=True)
    sys.exit(3)
if ac < rc:
    print("REPRO_CONFIRMED Executing_chip_using_runningCount_overstates_executing", flush=True)
elif ac == rc:
    print("NOTE all_slots_are_executing launching=0", flush=True)
print("OK identity holds", flush=True)
PY
