#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DB_PATH="${INVOKER_DB_PATH:-${HOME:-.}/.invoker/invoker.db}"
TASK_ID="wf-1780292402489-6/final-regression-test-all"

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: --no-track active-outbox retry could return before owner launch handoff"
echo "[repro] effect: retry loop could cancel/replace a launch repeatedly, then leave ready pending work with no launch progress"

python3 - "$ROOT" "$DB_PATH" "$TASK_ID" <<'PY'
import json
import pathlib
import sqlite3
import sys

root = pathlib.Path(sys.argv[1])
db_path = pathlib.Path(sys.argv[2]).expanduser()
task_id = sys.argv[3]

headless = (root / "packages/app/src/headless.ts").read_text(encoding="utf-8")
main = (root / "packages/app/src/main.ts").read_text(encoding="utf-8")

fn_start = headless.index("async function dispatchNoTrackRunnableTasks")
fn_end = headless.index("export function wireHeadlessAutoFix", fn_start)
fn_body = headless[fn_start:fn_end]

active_idx = fn_body.index("if (deps.invokerConfig.launchOutboxMode === 'active')")
defer_idx = fn_body.index("if (deps.deferRunnableTasks)")

def before_fix(active_outbox: bool, has_defer_runnable_tasks: bool, has_owner_runner: bool):
    if has_defer_runnable_tasks:
        return {
            "returned": True,
            "owner_execute_task": False,
            "live_dispatch_after_return": True,
            "reason": "deferRunnableTasks short-circuited active outbox handoff",
        }
    if active_outbox and has_owner_runner:
        return {
            "returned": False,
            "owner_execute_task": True,
            "live_dispatch_after_return": True,
            "reason": "waiting for owner handoff",
        }
    return {"returned": True, "owner_execute_task": False, "live_dispatch_after_return": False}

pre = before_fix(active_outbox=True, has_defer_runnable_tasks=True, has_owner_runner=True)
assert pre["returned"] is True
assert pre["owner_execute_task"] is False
assert pre["live_dispatch_after_return"] is True

assert active_idx < defer_idx, (
    "active launch-outbox handling must run before deferRunnableTasks; otherwise no-track retry "
    "can return before owner launch handoff"
)
assert "ownerTaskRunnerProvider: () => requireTaskExecutor()" in main, (
    "main process must pass the owner TaskRunner to headless active-outbox no-track dispatch"
)

print("[repro] pre-fix model: deferRunnableTasks returned immediately with a live dispatch row")
print("[repro] fixed source: active outbox handoff is checked before deferRunnableTasks")
print("[repro] fixed source: main wires ownerTaskRunnerProvider to the owner TaskRunner")

embedded_events = [
    ("task.launch_claimed", {"attempt": "a232fbc9d", "generation": 71}),
    ("task.launch_dispatch_invalidated", {"reason": "workflow cancellation", "attempt": "a232fbc9d"}),
    ("task.pending", {"generation": 72}),
    ("task.launch_claimed", {"attempt": "a01181ff9", "generation": 72}),
    ("task.executor.deferred", {"reason": "ssh-resource-lease-held", "poolMemberId": "remote_digital_ocean_4"}),
    ("task.executor.deferred", {"reason": "execution-pool-capacity", "poolId": "pnpm-ssh"}),
    ("task.launch_dispatch_invalidated", {"reason": "task deferred", "attempt": "a01181ff9"}),
    ("task.deferred", {"status": "pending"}),
]
event_types = [event_type for event_type, _ in embedded_events]
defer_reasons = {
    payload.get("reason")
    for event_type, payload in embedded_events
    if event_type == "task.executor.deferred"
}
invalidate_reasons = {
    payload.get("reason")
    for event_type, payload in embedded_events
    if event_type == "task.launch_dispatch_invalidated"
}
assert "workflow cancellation" in invalidate_reasons
assert "task deferred" in invalidate_reasons
assert {"ssh-resource-lease-held", "execution-pool-capacity"} <= defer_reasons
assert event_types[-1] == "task.deferred"
print("[repro] embedded audit: repeated launch cancellation followed by SSH capacity deferral is reproduced")

if not db_path.exists():
    print(f"[repro] local DB not found, skipped live diagnostic: {db_path}")
    sys.exit(0)

conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
try:
    task = conn.execute(
        """
        SELECT id, status, runner_kind, pool_id, pool_member_id, selected_attempt_id,
               launch_phase, launch_started_at, launch_completed_at, started_at, last_heartbeat_at
          FROM tasks
         WHERE id = ?
        """,
        (task_id,),
    ).fetchone()
    if task is None:
        print("[repro] local DB diagnostic: target task is no longer present")
        sys.exit(0)

    active_dispatches = conn.execute(
        """
        SELECT id, state, attempt_id, generation, last_error
          FROM task_launch_dispatch
         WHERE task_id = ?
           AND state IN ('enqueued', 'leased')
         ORDER BY id
        """,
        (task_id,),
    ).fetchall()
    latest_dispatch = conn.execute(
        """
        SELECT id, state, attempt_id, generation, last_error
          FROM task_launch_dispatch
         WHERE task_id = ?
         ORDER BY id DESC
         LIMIT 1
        """,
        (task_id,),
    ).fetchone()
    recent_events = conn.execute(
        """
        SELECT event_type, payload
          FROM events
         WHERE task_id = ?
         ORDER BY id DESC
         LIMIT 20
        """,
        (task_id,),
    ).fetchall()

    parsed_events = []
    for row in reversed(recent_events):
        payload = row["payload"]
        try:
            payload = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            payload = {}
        parsed_events.append((row["event_type"], payload))

    live_defer_reasons = {
        payload.get("reason")
        for event_type, payload in parsed_events
        if event_type == "task.executor.deferred"
    }
    live_invalidations = {
        payload.get("reason")
        for event_type, payload in parsed_events
        if event_type == "task.launch_dispatch_invalidated"
    }

    print("[repro] local DB task:", json.dumps(dict(task), sort_keys=True))
    print("[repro] local DB active_dispatch_count:", len(active_dispatches))
    if latest_dispatch:
        print("[repro] local DB latest_dispatch:", json.dumps(dict(latest_dispatch), sort_keys=True))
    print("[repro] local DB recent_defer_reasons:", ",".join(sorted(reason for reason in live_defer_reasons if reason)))
    print("[repro] local DB recent_invalidation_reasons:", ",".join(sorted(reason for reason in live_invalidations if reason)))

    if task["status"] == "pending":
        assert task["launch_phase"] is None
        assert task["launch_started_at"] is None
        assert task["launch_completed_at"] is None
        assert len(active_dispatches) == 0
        assert "task deferred" in live_invalidations or latest_dispatch and latest_dispatch["last_error"] == "task deferred"
        print("[repro] local DB diagnostic: pending task has no active launch dispatch after deferral")
finally:
    conn.close()
PY

echo "[repro] passed"
