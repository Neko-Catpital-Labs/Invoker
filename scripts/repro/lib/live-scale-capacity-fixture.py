#!/usr/bin/env python3
"""Build a live-shaped Invoker DB + config for capacity underfill repros.

Mirrors production shape (~51 workflows / ~160+ tasks, maxConcurrency 13 vs
pool capacity 12) and injects the requested underfill classes.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path


def write_config(path: Path, *, max_concurrency: int = 13) -> dict:
    cfg = {
        "maxConcurrency": max_concurrency,
        "executionPools": {
            "mixed-local-ssh": {
                "maxConcurrentTasksPerMember": 1,
                "members": (
                    [{"type": "ssh", "id": f"remote_digital_ocean_{i}"} for i in (1, 3, 4, 5, 6, 7)]
                    + [{"type": "worktree", "id": "local-fallback", "maxConcurrentTasks": 6}]
                ),
            }
        },
    }
    path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    return cfg


def build_db(
    db_path: Path,
    *,
    workflow_count: int = 51,
    running_budget: int = 4,
    include_expired_lease: bool = True,
    include_ready_without_dispatch: bool = True,
) -> dict:
    if db_path.exists():
        db_path.unlink()
    con = sqlite3.connect(db_path)
    con.executescript(
        """
        CREATE TABLE workflows (
          id TEXT PRIMARY KEY,
          name TEXT,
          created_at TEXT,
          updated_at TEXT
        );
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          status TEXT,
          runner_kind TEXT,
          pool_member_id TEXT,
          dependencies TEXT DEFAULT '[]',
          selected_attempt_id TEXT,
          launch_phase TEXT,
          blocked_by TEXT
        );
        CREATE TABLE task_launch_dispatch (
          id INTEGER PRIMARY KEY,
          task_id TEXT NOT NULL,
          attempt_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          state TEXT NOT NULL
        );
        CREATE TABLE execution_resource_leases (
          resource_key TEXT,
          resource_type TEXT,
          holder_id TEXT,
          task_id TEXT,
          pool_member_id TEXT,
          lease_expires_at TEXT,
          acquired_at TEXT
        );
        CREATE TABLE events (
          id INTEGER PRIMARY KEY,
          task_id TEXT,
          event_type TEXT,
          payload TEXT,
          created_at TEXT
        );
        """
    )

    depths = [9] + [5] * 4 + [4] * 6 + [3] * max(0, workflow_count - 11)
    task_count = 0
    ready_without_dispatch = 0
    remaining_running = running_budget

    for wi, depth in enumerate(depths[:workflow_count]):
        wf = f"wf-live-{wi}"
        con.execute(
            "INSERT INTO workflows VALUES (?,?,?,?)",
            (wf, wf, "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z"),
        )
        for ti in range(depth):
            task_id = f"{wf}/t{ti}"
            deps = json.dumps([f"{wf}/t{ti - 1}"] if ti > 0 else [])
            if ti == 0 and remaining_running > 0:
                status, phase, member = "running", "executing", f"m{remaining_running}"
                remaining_running -= 1
            elif ti == 0 and include_ready_without_dispatch:
                status, phase, member = "pending", None, None
                ready_without_dispatch += 1
            else:
                status, phase, member = "pending", None, None
            con.execute(
                "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)",
                (task_id, wf, status, "ssh", member, deps, f"{task_id}-a1", phase, ""),
            )
            task_count += 1
            if status == "pending" and ti == 0 and include_ready_without_dispatch:
                con.execute(
                    "INSERT INTO events VALUES (NULL,?,?,?,?)",
                    (
                        task_id,
                        "task.executor.deferred",
                        json.dumps({"reason": "execution-pool-capacity"}),
                        "2026-07-16T00:00:00.000Z",
                    ),
                )

    for i in range(200):
        con.execute(
            "INSERT INTO task_launch_dispatch VALUES (NULL,?,?,?,?)",
            ("wf-live-0/t0", f"old-attempt-{i}", "wf-live-0", "abandoned"),
        )

    if include_expired_lease:
        con.execute(
            "INSERT INTO execution_resource_leases VALUES (?,?,?,?,?,?,?)",
            (
                "ssh:expired-orphan",
                "ssh",
                "dead-holder",
                "wf-x/orphan",
                "remote_digital_ocean_1",
                "2000-01-01T00:00:00.000Z",
                "2000-01-01T00:00:00.000Z",
            ),
        )

    con.commit()
    con.close()
    return {
        "workflow_count": workflow_count,
        "task_count": task_count,
        "ready_without_dispatch": ready_without_dispatch,
        "running_budget": running_budget,
        "include_expired_lease": include_expired_lease,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--max-concurrency", type=int, default=13)
    parser.add_argument("--workflow-count", type=int, default=51)
    parser.add_argument("--running-budget", type=int, default=4)
    parser.add_argument("--no-expired-lease", action="store_true")
    parser.add_argument("--no-ready-without-dispatch", action="store_true")
    args = parser.parse_args()

    cfg = write_config(Path(args.config), max_concurrency=args.max_concurrency)
    meta = build_db(
        Path(args.db),
        workflow_count=args.workflow_count,
        running_budget=args.running_budget,
        include_expired_lease=not args.no_expired_lease,
        include_ready_without_dispatch=not args.no_ready_without_dispatch,
    )
    meta["config"] = {
        "maxConcurrency": cfg["maxConcurrency"],
        "poolCapacity": 12,
    }
    print(json.dumps(meta))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
