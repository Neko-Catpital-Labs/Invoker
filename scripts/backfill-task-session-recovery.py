#!/usr/bin/env python3
"""Backfill task_session_recovery from live tasks and transcript paths.

Safe to run twice: upserts on (workflow_id, agent_session_id).

Usage:
  python3 scripts/backfill-task-session-recovery.py --db ~/.invoker/invoker.db \\
    --projects-root ~/.invoker/claude-worker/projects \\
    [--config-dir ~/.invoker/claude-worker] [--dry-run]

Live task rows with agent_session_id are copied first (including crash fields
when task_crash_preservation still exists). Transcripts whose project directory
encodes experiment-wf-<id> supply workflow id, session id (filename), config
dir, and absolute path. Task id stays empty when the task row is already gone.
Prompt text is never used.
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
from pathlib import Path

WF_IN_PATH_RE = re.compile(r"experiment-wf-([0-9]+-[0-9]+)")


def normalize_session_id(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    if not trimmed or trimmed == "none":
        return None
    return trimmed


def upsert(
    conn: sqlite3.Connection,
    *,
    workflow_id: str,
    agent_session_id: str,
    task_id: str | None = None,
    config_dir: str | None = None,
    workspace_path: str | None = None,
    pool_id: str | None = None,
    transcript_path: str | None = None,
    crash_preserved_at: str | None = None,
    crash_report_path: str | None = None,
    crash_diagnostic_summary: str | None = None,
    dry_run: bool = False,
) -> None:
    if dry_run:
        return
    conn.execute(
        """
        INSERT INTO task_session_recovery (
          workflow_id, agent_session_id, task_id, config_dir, workspace_path, pool_id,
          transcript_path, crash_preserved_at, crash_report_path, crash_diagnostic_summary,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
        ON CONFLICT(workflow_id, agent_session_id) DO UPDATE SET
          task_id = COALESCE(excluded.task_id, task_session_recovery.task_id),
          config_dir = COALESCE(excluded.config_dir, task_session_recovery.config_dir),
          workspace_path = COALESCE(excluded.workspace_path, task_session_recovery.workspace_path),
          pool_id = COALESCE(excluded.pool_id, task_session_recovery.pool_id),
          transcript_path = COALESCE(excluded.transcript_path, task_session_recovery.transcript_path),
          crash_preserved_at = COALESCE(excluded.crash_preserved_at, task_session_recovery.crash_preserved_at),
          crash_report_path = COALESCE(excluded.crash_report_path, task_session_recovery.crash_report_path),
          crash_diagnostic_summary = COALESCE(
            excluded.crash_diagnostic_summary,
            task_session_recovery.crash_diagnostic_summary
          ),
          updated_at = excluded.updated_at
        """,
        (
            workflow_id,
            agent_session_id,
            task_id,
            config_dir,
            workspace_path,
            pool_id,
            transcript_path,
            crash_preserved_at,
            crash_report_path,
            crash_diagnostic_summary,
        ),
    )


def ensure_table(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS task_session_recovery (
          workflow_id TEXT NOT NULL,
          agent_session_id TEXT NOT NULL,
          task_id TEXT,
          config_dir TEXT,
          workspace_path TEXT,
          pool_id TEXT,
          transcript_path TEXT,
          crash_preserved_at TEXT,
          crash_report_path TEXT,
          crash_diagnostic_summary TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (workflow_id, agent_session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_task_session_recovery_session
          ON task_session_recovery(agent_session_id);
        CREATE INDEX IF NOT EXISTS idx_task_session_recovery_task
          ON task_session_recovery(task_id);
        """
    )


def backfill_live_tasks(conn: sqlite3.Connection, *, dry_run: bool, config_dir: str | None) -> int:
    has_crash = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_crash_preservation'"
    ).fetchone()
    sql = """
      SELECT
        t.workflow_id,
        t.id AS task_id,
        t.agent_session_id,
        t.last_agent_session_id,
        t.claude_session_id,
        t.workspace_path,
        t.pool_id
    """
    if has_crash:
        sql += """,
        cp.preserved_at,
        cp.diagnostic_report_path,
        cp.diagnostic_summary
      FROM tasks t
      LEFT JOIN task_crash_preservation cp ON cp.task_id = t.id
      """
    else:
        sql += """
      FROM tasks t
      """
    count = 0
    for row in conn.execute(sql):
        session_id = (
            normalize_session_id(row["agent_session_id"])
            or normalize_session_id(row["last_agent_session_id"])
            or normalize_session_id(row["claude_session_id"])
        )
        if not session_id:
            continue
        upsert(
            conn,
            workflow_id=str(row["workflow_id"]),
            agent_session_id=session_id,
            task_id=str(row["task_id"]),
            config_dir=config_dir,
            workspace_path=row["workspace_path"],
            pool_id=row["pool_id"],
            crash_preserved_at=row["preserved_at"] if has_crash else None,
            crash_report_path=row["diagnostic_report_path"] if has_crash else None,
            crash_diagnostic_summary=row["diagnostic_summary"] if has_crash else None,
            dry_run=dry_run,
        )
        count += 1
    return count


def backfill_transcript_paths(
    conn: sqlite3.Connection,
    projects_root: Path,
    *,
    config_dir: str | None,
    dry_run: bool,
) -> int:
    projects_root = projects_root.expanduser().resolve()
    if not projects_root.is_dir():
        return 0
    count = 0
    for dirpath, _dirnames, filenames in os.walk(projects_root):
        base = os.path.basename(dirpath)
        match = WF_IN_PATH_RE.search(base)
        if not match:
            continue
        workflow_id = f"wf-{match.group(1)}"
        for name in filenames:
            if not name.endswith(".jsonl") or name.startswith("agent-"):
                continue
            session_id = name[: -len(".jsonl")]
            if not normalize_session_id(session_id):
                continue
            transcript_path = str((Path(dirpath) / name).resolve())
            upsert(
                conn,
                workflow_id=workflow_id,
                agent_session_id=session_id,
                config_dir=config_dir,
                transcript_path=transcript_path,
                dry_run=dry_run,
            )
            count += 1
    return count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True, help="Path to Invoker SQLite database")
    parser.add_argument(
        "--projects-root",
        action="append",
        default=[],
        help="Claude projects root (repeatable). Default: <config-dir>/projects",
    )
    parser.add_argument(
        "--config-dir",
        default=None,
        help="Claude worker config dir (default: ~/.invoker/claude-worker or INVOKER_CLAUDE_CONFIG_DIR)",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    config_dir = args.config_dir or os.environ.get("INVOKER_CLAUDE_CONFIG_DIR") or str(
        Path.home() / ".invoker" / "claude-worker"
    )
    projects_roots = [Path(p) for p in args.projects_root] or [Path(config_dir) / "projects"]

    db_path = Path(args.db)
    if not db_path.is_file():
        print(f"database not found: {db_path}", file=sys.stderr)
        return 1

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        if not args.dry_run:
            ensure_table(conn)
        live = backfill_live_tasks(conn, dry_run=args.dry_run, config_dir=config_dir)
        path_count = 0
        for root in projects_roots:
            path_count += backfill_transcript_paths(
                conn, root, config_dir=config_dir, dry_run=args.dry_run
            )
        if not args.dry_run:
            conn.commit()
        print(f"live_task_rows={live} transcript_path_rows={path_count} dry_run={args.dry_run}")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    raise SystemExit(main())
