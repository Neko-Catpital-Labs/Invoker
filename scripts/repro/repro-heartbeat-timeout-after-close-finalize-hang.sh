#!/usr/bin/env bash
# Repro: heartbeats stop after child close while completion is delayed.
#
# This models the SSH executor close-path shape:
# - Child process exits quickly.
# - Entry is marked completed immediately in close handler.
# - Post-exit finalize work hangs (record/push).
# - Heartbeat timer stops, so watchdog sees stale heartbeat and fails task.
#
# Usage:
#   bash scripts/repro/repro-heartbeat-timeout-after-close-finalize-hang.sh
#
set -euo pipefail

python3 - <<'PY'
from __future__ import annotations

import subprocess
import threading
import time
from dataclasses import dataclass

HEARTBEAT_INTERVAL_S = 0.5
WATCHDOG_TIMEOUT_S = 3.0
FINALIZE_HANG_S = 4.5


@dataclass
class Entry:
    completed: bool = False
    last_heartbeat: float = 0.0
    completion_emitted: bool = False
    child_closed: bool = False


entry = Entry(last_heartbeat=time.monotonic())
lock = threading.Lock()
events: list[str] = []


def log(msg: str) -> None:
    now = time.monotonic()
    events.append(f"{now:.3f} {msg}")


def heartbeat_loop(proc: subprocess.Popen[str]) -> None:
    while True:
        time.sleep(HEARTBEAT_INTERVAL_S)
        with lock:
            if entry.completed:
                log("heartbeat_loop: stop (entry.completed=true)")
                return
            if proc.poll() is not None:
                # Mirrors BaseExecutor.startHeartbeat orphan fallback.
                log("heartbeat_loop: child exited before completion; would emit orphan failure")
                entry.completion_emitted = True
                return
            entry.last_heartbeat = time.monotonic()
            log("heartbeat")


def close_handler(proc: subprocess.Popen[str]) -> None:
    proc.wait()
    with lock:
        entry.child_closed = True
        # Mirrors ssh-executor close callback: mark completed before finalize.
        entry.completed = True
        log("close_handler: child closed; mark completed=true; start finalize")
    # Simulate hanging remoteGitRecordAndPush.
    time.sleep(FINALIZE_HANG_S)
    with lock:
        entry.completion_emitted = True
        log("close_handler: finalize done; emit completion")


proc = subprocess.Popen(["bash", "-lc", "exit 0"], text=True)
threading.Thread(target=heartbeat_loop, args=(proc,), daemon=True).start()
threading.Thread(target=close_handler, args=(proc,), daemon=True).start()

start = time.monotonic()
watchdog_fired = False
while time.monotonic() - start < WATCHDOG_TIMEOUT_S + 2.0:
    time.sleep(0.1)
    with lock:
        heartbeat_age = time.monotonic() - entry.last_heartbeat
        handle_present = True  # Entry/handle still exists until completion callback.
        if (not entry.completion_emitted) and handle_present and heartbeat_age >= WATCHDOG_TIMEOUT_S:
            log(
                "watchdog: STALL "
                f"(handlePresent={handle_present} completion={entry.completion_emitted} "
                f"heartbeatAge={heartbeat_age:.2f}s)"
            )
            watchdog_fired = True
            break

print("=== Repro timeline ===")
for line in events:
    print(line)

print("\n=== Result ===")
if watchdog_fired:
    print(
        "PASS: reproduced heartbeat timeout while handle remained present and completion was pending."
    )
    raise SystemExit(0)

print("FAIL: watchdog did not fire; adjust timing constants.")
raise SystemExit(1)
PY
