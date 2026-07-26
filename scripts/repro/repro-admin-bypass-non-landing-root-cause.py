#!/usr/bin/env python3
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

DB_PATH = Path.home() / '.invoker' / 'invoker.db'
REPO = 'Neko-Catpital-Labs/Invoker'
TARGET_PRS = (5801, 5811)
WORKER_SOURCE = 'pr-maintenance-worker'
WORKER_TAG = '[worker:pr-admin-bypass-land]'
PLACEHOLDER_REQUIRED_FAST = 'required-fast / ${{ matrix.name }}'


@dataclass(frozen=True)
class LogEvidence:
    timestamp: str
    level: str
    message: str


def run_gh_json(args: list[str]) -> dict:
    completed = subprocess.run(['gh', *args], text=True, capture_output=True, check=True)
    return json.loads(completed.stdout)


def connect_db() -> sqlite3.Connection:
    if not DB_PATH.exists():
        raise SystemExit(f'missing invoker db: {DB_PATH}')
    uri = f'file:{DB_PATH}?mode=ro&immutable=1'
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_worker_logs(conn: sqlite3.Connection, pr_number: int) -> list[LogEvidence]:
    cur = conn.cursor()
    cur.execute(
        '''
        select timestamp, level, message
        from activity_log
        where source = ? and message like ?
        order by datetime(timestamp) asc, id asc
        ''',
        (WORKER_SOURCE, f'%{pr_number}%'),
    )
    return [LogEvidence(str(row['timestamp']), str(row['level']), str(row['message'])) for row in cur.fetchall()]


def require_line(logs: list[LogEvidence], needle: str, label: str) -> LogEvidence:
    for row in logs:
        if needle in row.message:
            return row
    raise AssertionError(f'missing {label}: {needle}')


def gh_pr_snapshot(pr_number: int) -> dict:
    return run_gh_json([
        'pr', 'view', str(pr_number), '--repo', REPO,
        '--json', 'number,title,state,labels,headRefOid,statusCheckRollup',
    ])


def check_names(snapshot: dict) -> list[str]:
    return [node.get('name') or node.get('context') or '' for node in snapshot.get('statusCheckRollup') or []]


def summarize_5801(conn: sqlite3.Connection) -> tuple[dict, list[str]]:
    logs = fetch_worker_logs(conn, 5801)
    ts_repair = require_line(logs, 'repair-check PR #5801 check="quality / TypeScript Types"', '5801 repair check')
    ts_pushed = require_line(logs, "Pushed to PR #5801's head branch (`871f16fb6`).", '5801 push')
    ts_conflict = require_line(logs, 'repair-conflict PR #5801 GitHub reports merge conflict', '5801 conflict repair')
    ts_fixed = require_line(logs, 'Force-pushed the rebased branch to the PR head.', '5801 fixed note')
    ts_stalled = require_line(logs, '"kind": "comment_blocked", "pr_number": 5803', '5801 stack blocked by 5803')
    snapshot = gh_pr_snapshot(5801)
    names = check_names(snapshot)
    assert 'required-fast / Guardrails' not in names, '5801 unexpectedly has required-fast / Guardrails'
    assert 'required-fast / Submit Workflow Chain' not in names, '5801 unexpectedly has required-fast / Submit Workflow Chain'
    assert PLACEHOLDER_REQUIRED_FAST in names, '5801 missing placeholder required-fast check name'
    return {
        'pr': 5801,
        'state': snapshot['state'],
        'labels': [label['name'] for label in snapshot['labels']],
        'head': snapshot['headRefOid'],
        'repair_started_at': ts_repair.timestamp,
        'repair_pushed_at': ts_pushed.timestamp,
        'conflict_repaired_at': ts_conflict.timestamp,
        'fixed_note_at': ts_fixed.timestamp,
        'stalled_on_stack_at': ts_stalled.timestamp,
        'root_cause': '5801 was repaired, then rebased, but its head still lacked the required-fast check contexts and the worker kept prioritizing capped PR #5803 in the same stack.',
    }, names


def summarize_5811(conn: sqlite3.Connection) -> tuple[dict, list[str]]:
    logs = fetch_worker_logs(conn, 5811)
    ts_dequeued = require_line(logs, '"latest_mergify": {"comment_id": "5078148864", "failing_checks": ["required-fast / Guardrails"]', '5811 dequeued trace')
    ts_block = require_line(logs, 'BLOCK PR #5811 missing-check', '5811 blocked comment')
    repair_lines = [row for row in logs if 'repair-check PR #5811' in row.message or 'admin-bypass-repair-check-start' in row.message and '"pr_number": 5811' in row.message]
    if repair_lines:
        raise AssertionError('5811 unexpectedly has a repair-check execution in live logs')
    snapshot = gh_pr_snapshot(5811)
    names = check_names(snapshot)
    assert 'required-fast / Guardrails' not in names, '5811 unexpectedly has required-fast / Guardrails'
    assert PLACEHOLDER_REQUIRED_FAST in names, '5811 missing placeholder required-fast check name'
    return {
        'pr': 5811,
        'state': snapshot['state'],
        'labels': [label['name'] for label in snapshot['labels']],
        'head': snapshot['headRefOid'],
        'dequeued_trace_at': ts_dequeued.timestamp,
        'blocked_at': ts_block.timestamp,
        'root_cause': '5811 left the queue on a merge-queue Guardrails failure, but the original PR head never had that required-fast check context, so the worker only emitted missing-check blocks and never repaired or requeued it.',
    }, names


def main() -> int:
    conn = connect_db()
    try:
        summary_5801, names_5801 = summarize_5801(conn)
        summary_5811, names_5811 = summarize_5811(conn)
    finally:
        conn.close()

    print('Admin-bypass non-landing root cause repro')
    print(f'DB: {DB_PATH}')
    print()
    print('| PR | labels | live proof of worker handling | live proof of fix | live blocker after fix | root cause |')
    print('|---|---|---|---|---|---|')
    print(
        f"| 5801 | {','.join(summary_5801['labels'])} | repair-check at {summary_5801['repair_started_at']} | pushed at {summary_5801['repair_pushed_at']}; rebased/fixed at {summary_5801['fixed_note_at']} | stack blocked at {summary_5801['stalled_on_stack_at']} while required-fast checks were absent on head {summary_5801['head']} | {summary_5801['root_cause']} |"
    )
    print(
        f"| 5811 | {','.join(summary_5811['labels'])} | dequeued failing-check trace at {summary_5811['dequeued_trace_at']} | none in worker logs | repeated missing-check block at {summary_5811['blocked_at']} while required-fast check was absent on head {summary_5811['head']} | {summary_5811['root_cause']} |"
    )
    print()
    print('5801 check names:')
    for name in names_5801:
        print(f'  - {name}')
    print('5811 check names:')
    for name in names_5811:
        print(f'  - {name}')
    print()
    print('Shared signature: both PR heads are missing the exact required-fast check names that Mergify requires; only placeholder skipped check names remain on the PR heads.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f'REPRO FAILED: {exc}', file=sys.stderr)
        raise SystemExit(1)
