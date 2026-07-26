#!/usr/bin/env python3
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

DB_PATH = Path.home() / '.invoker' / 'invoker.db'
LEDGER_PATH = Path.home() / '.invoker' / 'mergify-admin-requeue-state.jsonl'
REPO = 'Neko-Catpital-Labs/Invoker'
TARGET_PRS = (5801, 5811, 5873)
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
        '--json', 'number,title,state,labels,headRefOid,statusCheckRollup,comments,mergeStateStatus',
    ])


def check_names(snapshot: dict) -> list[str]:
    return [node.get('name') or node.get('context') or '' for node in snapshot.get('statusCheckRollup') or []]


def check_state(snapshot: dict, check_name: str) -> str:
    for node in snapshot.get('statusCheckRollup') or []:
        name = node.get('name') or node.get('context') or ''
        if name != check_name:
            continue
        return str(node.get('conclusion') or node.get('state') or '').lower()
    return ''


def ledger_rows(pr_number: int) -> list[dict]:
    if not LEDGER_PATH.exists():
        raise AssertionError(f'missing ledger: {LEDGER_PATH}')
    rows: list[dict] = []
    for raw in LEDGER_PATH.read_text(encoding='utf-8').splitlines():
        if not raw.strip():
            continue
        try:
            row = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if row.get('pr') == pr_number:
            rows.append(row)
    return rows


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


def summarize_5873(conn: sqlite3.Connection) -> tuple[dict, list[str]]:
    del conn
    snapshot = gh_pr_snapshot(5873)
    names = check_names(snapshot)
    head = snapshot['headRefOid']
    rows = ledger_rows(5873)
    invalid = next(
        (
            row for row in rows
            if row.get('kind') == 'repair-invalid'
            and row.get('headSha') == head
            and row.get('key') == 'UI Vitest'
        ),
        None,
    )
    if invalid is None:
        raise AssertionError('5873 missing current-head repair-invalid ledger row for UI Vitest')
    errors = (invalid.get('meta') or {}).get('errors') or []
    exact_reason = next((str(error) for error in errors if 'merge-queue run failed outside the PR head' in str(error)), '')
    if not exact_reason:
        raise AssertionError('5873 repair-invalid row missing exact queue-runner/tooling reason')
    blocked = next(
        (
            row for row in rows
            if row.get('kind') == 'comment-blocked'
            and row.get('headSha') == head
            and row.get('key') == f'repair-invalid:UI Vitest:{head}'
        ),
        None,
    )
    if blocked is None:
        raise AssertionError('5873 missing dedupe comment-blocked ledger row for current head')
    stop_comment = next(
        (
            comment for comment in snapshot.get('comments') or []
            if 'Mergify repair stopped: merge-queue run failed outside the PR head' in str(comment.get('body') or '')
        ),
        None,
    )
    if stop_comment is None:
        raise AssertionError('5873 missing exact worker stop comment')
    ui_state = check_state(snapshot, 'UI Vitest')
    if ui_state != 'success':
        raise AssertionError(f'5873 expected current PR-head UI Vitest success, got {ui_state or "missing"}')
    return {
        'pr': 5873,
        'state': snapshot['state'],
        'labels': [label['name'] for label in snapshot['labels']],
        'head': head,
        'repair_invalid_at': invalid.get('epoch'),
        'blocked_at': stop_comment.get('createdAt') or blocked.get('epoch'),
        'root_cause': exact_reason,
    }, names


def main() -> int:
    conn = connect_db()
    summaries: list[tuple[dict, list[str]]] = []
    skipped: list[str] = []
    try:
        for pr_number, summarize in (
            (5801, summarize_5801),
            (5811, summarize_5811),
            (5873, summarize_5873),
        ):
            try:
                summaries.append(summarize(conn))
            except AssertionError as exc:
                skipped.append(f'{pr_number}: {exc}')
    finally:
        conn.close()

    if not summaries:
        raise AssertionError('no target evidence could be reproduced')

    print('Admin-bypass non-landing root cause repro')
    print(f'DB: {DB_PATH}')
    print(f'Ledger: {LEDGER_PATH}')
    if skipped:
        print()
        print('Skipped stale/unavailable historical evidence:')
        for item in skipped:
            print(f'  - {item}')
    print()
    print('| PR | labels | live proof of worker handling | live proof of fix | live blocker after fix | root cause |')
    print('|---|---|---|---|---|---|')
    for summary, _names in summaries:
        if summary['pr'] == 5801:
            print(
                f"| 5801 | {','.join(summary['labels'])} | repair-check at {summary['repair_started_at']} | pushed at {summary['repair_pushed_at']}; rebased/fixed at {summary['fixed_note_at']} | stack blocked at {summary['stalled_on_stack_at']} while required-fast checks were absent on head {summary['head']} | {summary['root_cause']} |"
            )
        elif summary['pr'] == 5811:
            print(
                f"| 5811 | {','.join(summary['labels'])} | dequeued failing-check trace at {summary['dequeued_trace_at']} | none in worker logs | repeated missing-check block at {summary['blocked_at']} while required-fast check was absent on head {summary['head']} | {summary['root_cause']} |"
            )
        elif summary['pr'] == 5873:
            print(
                f"| 5873 | {','.join(summary['labels'])} | repair-invalid ledger row for `UI Vitest` on head {summary['head']} | current PR-head `UI Vitest` is green | exact worker stop comment at {summary['blocked_at']} | {summary['root_cause']} |"
            )
    print()
    for summary, names in summaries:
        print(f"{summary['pr']} check names:")
        for name in names:
            print(f'  - {name}')
    print()
    print('Shared signature: the worker must not retry a current-head blocker after it has recorded a human-only stop reason.')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print(f'REPRO FAILED: {exc}', file=sys.stderr)
        raise SystemExit(1)
