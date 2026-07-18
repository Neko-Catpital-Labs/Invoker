#!/usr/bin/env python3
"""Detached capacity babysit + refill daemon. Logs to OUT jsonl + stdout."""
from __future__ import annotations

import datetime
import json
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TARGET = int(sys.argv[1]) if len(sys.argv) > 1 else 12
DURATION_S = int(sys.argv[2]) if len(sys.argv) > 2 else 300
# Default 60s — queue queries must not compete with the UI's 2s poll.
INTERVAL_S = int(sys.argv[3]) if len(sys.argv) > 3 else 60
OUT = Path(sys.argv[4] if len(sys.argv) > 4 else "/tmp/invoker-capacity-daemon.jsonl")


def run(cmd: list[str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, timeout=timeout)


def gui_procs() -> list[str]:
    p = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True)
    return [
        line
        for line in p.stdout.splitlines()
        if "packages/app/dist/main.js" in line and "headless" not in line
    ]


def extract_queue(raw: str) -> dict:
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
                return json.loads(blob[: i + 1])
    raise RuntimeError("unbalanced queue json")


def query_queue() -> tuple[str | None, dict]:
    # Prefer headless-client so we never rebuild and never open the DB locally.
    p = run(
        ["node", "./packages/app/dist/headless-client.js", "query", "queue", "--output", "json"],
        timeout=90,
    )
    raw = p.stdout + "\n" + p.stderr
    mode = None
    if "spawning detached standalone" in raw or "[init] Loaded" in raw:
        mode = "bootstrap-standalone"
    elif "mode=gui" in raw or "ownerId=" in raw:
        mode = "gui"
    elif "mode=standalone" in raw:
        mode = "standalone"
    elif gui_procs():
        mode = "gui"
    return mode, extract_queue(raw)


def refill() -> int:
    print("REFILL --recreate-all", flush=True)
    try:
        p = run(
            [
                "node",
                "./packages/app/dist/headless-client.js",
                "start-ready",
                "--recreate-all",
                "--no-track",
            ],
            timeout=600,
        )
    except subprocess.TimeoutExpired:
        print("REFILL_TIMEOUT", flush=True)
        return 124
    raw = p.stdout + "\n" + p.stderr
    if "spawning detached standalone" in raw or "[init] Loaded" in raw:
        print("REFILL_SPAWNED_STANDALONE", flush=True)
        return 125
    print(f"refill_exit={p.returncode}", flush=True)
    return p.returncode


def restart_gui() -> bool:
    print("RESTART_GUI", flush=True)
    run(["./scripts/kill-all-electron.sh"], timeout=60)
    time.sleep(1)
    Path("/tmp/invoker-gui.log").write_text("")
    subprocess.Popen(
        ["./run.sh"],
        cwd=str(ROOT),
        stdout=open("/tmp/invoker-gui.log", "a"),
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    deadline = time.time() + 480
    while time.time() < deadline:
        if gui_procs():
            p = run(
                ["node", "./packages/app/dist/headless-client.js", "query", "stats", "--output", "json"],
                timeout=90,
            )
            raw = p.stdout + "\n" + p.stderr
            if (
                ("mode=gui" in raw or "ownerId=" in raw)
                and "spawning detached standalone" not in raw
                and "[init] Loaded" not in raw
            ):
                print("GUI_READY", flush=True)
                return True
        time.sleep(6)
    print("GUI_START_TIMEOUT", flush=True)
    return False


def main() -> int:
    OUT.write_text("")
    start = time.time()
    below = False
    print(
        f"daemon: target>={TARGET} for {DURATION_S}s every {INTERVAL_S}s -> {OUT}",
        flush=True,
    )
    while True:
        elapsed = time.time() - start
        ts = datetime.datetime.utcnow().isoformat() + "Z"
        try:
            if not gui_procs():
                below = True
                if not restart_gui():
                    sample = {"ts": ts, "elapsed_s": round(elapsed, 1), "ok": False, "error": "gui-start-failed"}
                    OUT.open("a").write(json.dumps(sample) + "\n")
                    print(f"[{ts}] GUI_FAIL", flush=True)
                    time.sleep(INTERVAL_S)
                    continue
                refill()

            mode, q = query_queue()
            running = q.get("runningCount") or 0
            active = q.get("activeExecutionCount") or 0
            launching = q.get("launchingCount") or 0
            queued = len(q.get("queued") or [])
            ok = mode == "gui" and running >= TARGET
            sample = {
                "ts": ts,
                "elapsed_s": round(elapsed, 1),
                "mode": mode,
                "runningCount": running,
                "activeExecutionCount": active,
                "launchingCount": launching,
                "queuedCount": queued,
                "maxConcurrency": q.get("maxConcurrency"),
                "ok": ok,
                "guiProcs": len(gui_procs()),
            }
            if running < TARGET and mode == "gui":
                below = True
                sample["refill"] = True
                sample["refill_exit"] = refill()
            if mode != "gui":
                below = True
                sample["ok"] = False
            OUT.open("a").write(json.dumps(sample) + "\n")
            status = "OK" if sample["ok"] else "BELOW"
            print(
                f"[{ts}] t+{elapsed:5.0f}s {status} mode={mode} running={running} "
                f"active={active} launching={launching} queued={queued}",
                flush=True,
            )
        except Exception as exc:
            below = True
            OUT.open("a").write(
                json.dumps({"ts": ts, "elapsed_s": round(elapsed, 1), "ok": False, "error": str(exc)}) + "\n"
            )
            print(f"[{ts}] ERR {exc}", flush=True)

        if elapsed >= DURATION_S:
            break
        time.sleep(INTERVAL_S)

    result = "STABLE" if not below else "FAILED"
    print(f"RESULT={result}", flush=True)
    return 0 if not below else 1


if __name__ == "__main__":
    raise SystemExit(main())
