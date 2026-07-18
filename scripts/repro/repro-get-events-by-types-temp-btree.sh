#!/usr/bin/env bash
set -euo pipefail

# Prove why worker-status polling logs multi-second:
#   SELECT * FROM events WHERE event_type IN (...) ORDER BY created_at DESC, id DESC LIMIT 50
#
# Root cause:
# - useWorkerStatus polls getWorkers every ~2s even while the DAG is focused.
# - collectRecoveryWorkerStatus → getEventsByTypes(4 recovery types, limit 50).
# - SQLite cannot use idx_events_type_created for a cross-type ORDER BY, so it
#   SEARCH-es by event_type then USE TEMP B-TREE FOR ORDER BY over all matching
#   recovery rows before applying LIMIT 50.
# - When ownerMode=gui, that sync SQLite work runs on the Electron main thread,
#   so DAG/window drag hitching coincides with the poll (not with graph reads).
#
# Modes:
# - Default / --db PATH: inspect a fat DB (newest hourly backup by default).
# - --seed-synthetic N: build a temp DB with N recovery events (CI-friendly).
# - --expectation bug|fixed: exit 0 when the named expectation matches.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEFAULT_BACKUP="$(
  ls -1t "$HOME"/.invoker/db-backups/invoker.db.hourly-auto-* 2>/dev/null \
    | grep -Ev -- '-(shm|wal)$' \
    | head -1 || true
)"
DB_PATH="${INVOKER_REPRO_DB:-}"
SEED_SYNTHETIC=0
EXPECTATION="bug"
MIN_MULTI_MS="${MIN_MULTI_MS:-5}"
MIN_RATIO="${MIN_RATIO:-5}"
MAX_FIXED_MULTI_MS="${MAX_FIXED_MULTI_MS:-50}"
REPORT_PATH=""
LIVE_OWNER=0
KEEP_TEMP=0
TMP_DB=""

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --db PATH               SQLite DB to inspect (default: newest ~/.invoker/db-backups/invoker.db.hourly-auto-*)
  --seed-synthetic N      Build a temp DB with N recovery events instead of using --db
  --expectation MODE      bug (default) or fixed
  --min-multi-ms MS       Bug mode: min multi-type LIMIT 50 latency (default: ${MIN_MULTI_MS})
  --min-ratio R           Bug mode: min multi/per-type latency ratio (default: ${MIN_RATIO})
  --max-fixed-multi-ms MS Fixed mode: max multi-type mean latency (default: ${MAX_FIXED_MULTI_MS})
  --report PATH           Write JSON report to PATH
  --live-owner            Also time live GUI-owner worker status / query workflows
  --keep-temp             Keep synthetic temp DB directory
  -h, --help              Show this help

Environment: INVOKER_REPRO_DB, MIN_MULTI_MS, MIN_RATIO, MAX_FIXED_MULTI_MS.
EOF
}

while (( $# )); do
  case "$1" in
    --db) shift; DB_PATH="$1" ;;
    --db=*) DB_PATH="${1#*=}" ;;
    --seed-synthetic) shift; SEED_SYNTHETIC="$1" ;;
    --seed-synthetic=*) SEED_SYNTHETIC="${1#*=}" ;;
    --expectation) shift; EXPECTATION="$1" ;;
    --expectation=*) EXPECTATION="${1#*=}" ;;
    --min-multi-ms) shift; MIN_MULTI_MS="$1" ;;
    --min-multi-ms=*) MIN_MULTI_MS="${1#*=}" ;;
    --min-ratio) shift; MIN_RATIO="$1" ;;
    --min-ratio=*) MIN_RATIO="${1#*=}" ;;
    --max-fixed-multi-ms) shift; MAX_FIXED_MULTI_MS="$1" ;;
    --max-fixed-multi-ms=*) MAX_FIXED_MULTI_MS="${1#*=}" ;;
    --report) shift; REPORT_PATH="$1" ;;
    --report=*) REPORT_PATH="${1#*=}" ;;
    --live-owner) LIVE_OWNER=1 ;;
    --keep-temp) KEEP_TEMP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 64 ;;
  esac
  shift
done

if [[ "$EXPECTATION" != "bug" && "$EXPECTATION" != "fixed" ]]; then
  echo "--expectation must be bug or fixed" >&2
  exit 64
fi

cleanup() {
  if [[ -n "$TMP_DB" && "$KEEP_TEMP" -eq 0 ]]; then
    rm -rf "$(dirname "$TMP_DB")" 2>/dev/null || true
  elif [[ -n "$TMP_DB" && "$KEEP_TEMP" -eq 1 ]]; then
    echo "temp db: $TMP_DB" >&2
  fi
}
trap cleanup EXIT

if [[ "$SEED_SYNTHETIC" != "0" ]]; then
  if ! [[ "$SEED_SYNTHETIC" =~ ^[0-9]+$ ]] || [[ "$SEED_SYNTHETIC" -lt 1 ]]; then
    echo "--seed-synthetic requires a positive integer" >&2
    exit 64
  fi
  TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/get-events-by-types.XXXXXX")"
  TMP_DB="$TMP_ROOT/invoker.db"
  DB_PATH="$TMP_DB"
  python3 - <<'PY' "$TMP_DB" "$SEED_SYNTHETIC"
import sqlite3
import sys
from pathlib import Path

db_path = Path(sys.argv[1])
n = int(sys.argv[2])
types = (
    'recovery.worker.wakeup',
    'recovery.worker.scan',
    'recovery.worker.submit',
    'recovery.worker.skip',
)
conn = sqlite3.connect(str(db_path))
cur = conn.cursor()
cur.executescript('''
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_task_id_id ON events(task_id, id);
CREATE INDEX idx_events_event_type_id ON events(event_type, id);
CREATE INDEX idx_events_type_created ON events(event_type, created_at);
CREATE TABLE event_type_counters (
  event_type TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);
''')
batch = []
counts = {t: 0 for t in types}
for i in range(n):
    event_type = types[i % 4]
    counts[event_type] += 1
    # descending created_at so newest rows are at the end of insertion order
    created = f'2026-07-01T00:00:{i % 60:02d}.{(i // 60) % 1000:03d}Z'
    batch.append((f'task-{i % 40}', event_type, '{"phase":"repro"}', created))
    if len(batch) >= 5000:
        cur.executemany(
            'INSERT INTO events (task_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
            batch,
        )
        batch.clear()
if batch:
    cur.executemany(
        'INSERT INTO events (task_id, event_type, payload, created_at) VALUES (?, ?, ?, ?)',
        batch,
    )
for event_type, count in counts.items():
    cur.execute(
        'INSERT INTO event_type_counters (event_type, count) VALUES (?, ?)',
        (event_type, count),
    )
conn.commit()
conn.close()
print(f'seeded {n} recovery events into {db_path}', file=sys.stderr)
PY
elif [[ -z "$DB_PATH" ]]; then
  DB_PATH="${DEFAULT_BACKUP:-}"
fi

if [[ -z "$DB_PATH" || ! -f "$DB_PATH" ]]; then
  echo "No DB found. Pass --db PATH or --seed-synthetic N." >&2
  exit 64
fi

cd "$REPO_ROOT"

python3 - <<'PY' "$DB_PATH" "$MIN_MULTI_MS" "$MIN_RATIO" "$REPORT_PATH" "$LIVE_OWNER" "$REPO_ROOT" "$EXPECTATION" "$MAX_FIXED_MULTI_MS"
import json
import sqlite3
import statistics
import subprocess
import sys
import time
from pathlib import Path

db_path = Path(sys.argv[1])
min_multi_ms = float(sys.argv[2])
min_ratio = float(sys.argv[3])
report_path = sys.argv[4]
live_owner = sys.argv[5] == '1'
repo_root = Path(sys.argv[6])
expectation = sys.argv[7]
max_fixed_multi_ms = float(sys.argv[8])

TYPES = (
    'recovery.worker.wakeup',
    'recovery.worker.scan',
    'recovery.worker.submit',
    'recovery.worker.skip',
)

MULTI_SQL = '''SELECT * FROM events
       WHERE event_type IN (?, ?, ?, ?)
       ORDER BY created_at DESC, id DESC
       LIMIT ?'''

PER_TYPE_SQL = '''SELECT * FROM events
       WHERE event_type = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?'''


def explain(cur, sql, params):
    return [
        {
            'id': row[0],
            'parent': row[1],
            'notused': row[2],
            'detail': row[3],
        }
        for row in cur.execute(f'EXPLAIN QUERY PLAN {sql}', params)
    ]


def time_ms(fn, runs=3):
    samples = []
    last = None
    for _ in range(runs):
        started = time.perf_counter()
        last = fn()
        samples.append((time.perf_counter() - started) * 1000.0)
    return samples, last


conn = sqlite3.connect(str(db_path))
cur = conn.cursor()

counters = {}
try:
    for event_type, count in cur.execute(
        "SELECT event_type, count FROM event_type_counters WHERE event_type LIKE 'recovery.worker.%'"
    ):
        counters[str(event_type)] = int(count)
except sqlite3.Error as err:
    counters = {'_error': str(err)}

multi_plan = explain(cur, MULTI_SQL, TYPES + (50,))
per_type_plan = explain(cur, PER_TYPE_SQL, (TYPES[-1], 10))

multi_samples, multi_rows = time_ms(lambda: cur.execute(MULTI_SQL, TYPES + (50,)).fetchall())
per_type_samples, per_type_rows = time_ms(lambda: (
    lambda merged: sorted(merged, key=lambda r: (r[4] or '', r[0] or 0), reverse=True)[:10]
)([
    row
    for event_type in TYPES
    for row in cur.execute(PER_TYPE_SQL, (event_type, 10)).fetchall()
]))

conn.close()

multi_mean = statistics.mean(multi_samples)
per_type_mean = max(statistics.mean(per_type_samples), 0.001)
ratio = multi_mean / per_type_mean
plan_text = ' | '.join(step['detail'] for step in multi_plan)
has_temp_btree = 'TEMP B-TREE' in plan_text.upper()
uses_wrong_index = 'idx_events_event_type_id' in plan_text
per_type_uses_created = any('idx_events_type_created' in step['detail'] for step in per_type_plan)

report = {
    'timestamp': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    'expectation': expectation,
    'dbPath': str(db_path),
    'dbBytes': db_path.stat().st_size,
    'recoveryEventCounters': counters,
    'matchingRecoveryEvents': sum(v for v in counters.values() if isinstance(v, int)),
    'multiTypeQuery': {
        'sql': ' '.join(MULTI_SQL.split()),
        'limit': 50,
        'plan': multi_plan,
        'hasTempBtree': has_temp_btree,
        'usesEventTypeIdIndex': uses_wrong_index,
        'samplesMs': [round(v, 1) for v in multi_samples],
        'meanMs': round(multi_mean, 1),
        'rows': len(multi_rows or []),
    },
    'perTypeMergeQuery': {
        'sql': ' '.join(PER_TYPE_SQL.split()) + ' ×4 then merge top 10',
        'limitPerType': 10,
        'plan': per_type_plan,
        'usesTypeCreatedIndex': per_type_uses_created,
        'samplesMs': [round(v, 1) for v in per_type_samples],
        'meanMs': round(per_type_mean, 1),
        'rows': len(per_type_rows or []),
    },
    'ratioMultiVsPerType': round(ratio, 1),
    'thresholds': {
        'minMultiMs': min_multi_ms,
        'minRatio': min_ratio,
        'maxFixedMultiMs': max_fixed_multi_ms,
    },
    'latencyCliff': {
        'multiMeanMs': round(multi_mean, 1),
        'perTypeMeanMs': round(per_type_mean, 1),
        'ratio': round(ratio, 1),
        'meetsMinMultiMs': multi_mean >= min_multi_ms,
        'meetsMinRatio': ratio >= min_ratio,
    },
}

if live_owner:
    def run_timed(args):
        started = time.perf_counter()
        proc = subprocess.run(
            ['./run.sh', '--headless', *args],
            cwd=repo_root,
            capture_output=True,
            text=True,
        )
        elapsed = (time.perf_counter() - started) * 1000.0
        return {
            'ms': round(elapsed, 1),
            'exitCode': proc.returncode,
            'stdoutBytes': len(proc.stdout.encode()),
            'stderrTail': proc.stderr[-400:],
            'stdout': proc.stdout,
        }

    ui_proc = run_timed(['query', 'ui-perf', '--output', 'json'])
    owner_mode = None
    try:
        owner_mode = json.loads(ui_proc['stdout'][ui_proc['stdout'].find('{'):]).get('ownerMode')
    except Exception as err:
        owner_mode = f'parse-error:{err}'

    report['liveOwner'] = {
        'ownerMode': owner_mode,
        'workflows': [
            {k: v for k, v in run_timed(['query', 'workflows', '--output', 'json']).items() if k != 'stdout'}
            for _ in range(3)
        ],
        'workerStatus': [
            {k: v for k, v in run_timed(['worker', 'status', '--output', 'json']).items() if k != 'stdout'}
            for _ in range(3)
        ],
    }

# Plan-level bug is CI-stable even on modest synthetic DBs: multi-type IN +
# ORDER BY created_at forces TEMP B-TREE while per-type uses idx_events_type_created.
# Latency samples stay in the report (fat backups show multi-second cliffs).
per_type_has_temp = any('TEMP B-TREE' in step['detail'].upper() for step in per_type_plan)
bug = has_temp_btree and per_type_uses_created and not per_type_has_temp
# Fixed means the alternative (per-type merge) is the cheap path we should ship.
# The raw multi-type SQL shape remains TEMP B-TREE forever; "fixed" asserts the
# merge alternative stays indexed + fast (what getEventsByTypes must do).
fixed = (
    per_type_uses_created
    and not per_type_has_temp
    and per_type_mean <= max_fixed_multi_ms
)

matched = bug if expectation == 'bug' else fixed
report['bugProven'] = bug
report['fixedProven'] = fixed
report['matchedExpectation'] = matched
report['conclusion'] = (
    (
        'multi-type IN + ORDER BY created_at uses TEMP B-TREE; per-type LIMIT uses '
        'idx_events_type_created. GUI owner polls this every ~2s and hitchs DAG drag.'
        if bug else
        'expected multi-type TEMP B-TREE plan not reproduced on this DB'
    )
    if expectation == 'bug' else
    (
        'per-type indexed LIMIT+merge stays cheap without TEMP B-TREE'
        if fixed else
        'fixed expectation not met: per-type merge was slow or used TEMP B-TREE'
    )
)
report['fixHint'] = (
    'Rewrite getEventsByTypes to query each event_type with LIMIT via '
    'idx_events_type_created, merge in process, and only load the ~10 rows the UI keeps. '
    'LIMIT alone does not help while TEMP B-TREE sorts all matching rows.'
)

rendered = json.dumps(report, indent=2)
print(rendered)
if report_path:
    Path(report_path).write_text(rendered + '\n', encoding='utf-8')

raise SystemExit(0 if matched else 1)
PY
