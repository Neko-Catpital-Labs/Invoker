#!/usr/bin/env bash
# Forensic capacity audit: DB + optional log → underfill verdict.
# Usage:
#   bash scripts/repro/capacity-audit.sh [--db PATH] [--log PATH] [--config PATH] [--json]
set -euo pipefail

DB_PATH="${INVOKER_DB_PATH:-$HOME/.invoker/invoker.db}"
LOG_PATH="${INVOKER_LOG_PATH:-$HOME/.invoker/invoker.log}"
CONFIG_PATH="${INVOKER_CONFIG_PATH:-$HOME/.invoker/config.json}"
OUTPUT_JSON=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --db) DB_PATH="$2"; shift 2 ;;
    --log) LOG_PATH="$2"; shift 2 ;;
    --config) CONFIG_PATH="$2"; shift 2 ;;
    --json) OUTPUT_JSON=1; shift ;;
    -h|--help)
      sed -n '2,5p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$DB_PATH" ]; then
  echo "FAIL: DB not found: $DB_PATH" >&2
  exit 1
fi

python3 - "$DB_PATH" "$LOG_PATH" "$CONFIG_PATH" "$OUTPUT_JSON" <<'PY'
import json
import os
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

db_path, log_path, config_path, output_json = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"

def parse_iso(value):
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None

now = datetime.now(timezone.utc)

config = {}
if os.path.isfile(config_path):
    with open(config_path, encoding="utf-8") as fh:
        config = json.load(fh)

max_concurrency = config.get("maxConcurrency")
pools = config.get("executionPools") or {}
capacity_by_resource = {}
for pool in pools.values():
    members = pool.get("members") or []
    per_member = pool.get("maxConcurrentTasksPerMember")
    for member in members:
        key = f"{member.get('type')}:{member.get('id')}"
        if member.get("type") == "ssh":
            cap = member.get("maxConcurrentTasks") or per_member or 1
        else:
            cap = member.get("maxConcurrentTasks") or 1
        try:
            cap = int(cap)
        except (TypeError, ValueError):
            cap = 1
        capacity_by_resource[key] = max(capacity_by_resource.get(key, 0), cap)
pool_capacity = sum(capacity_by_resource.values()) if capacity_by_resource else None
try:
    max_concurrency_i = int(max_concurrency) if max_concurrency is not None else None
except (TypeError, ValueError):
    max_concurrency_i = None
expected_cap = None
if max_concurrency_i and pool_capacity:
    expected_cap = min(max_concurrency_i, pool_capacity)
elif max_concurrency_i:
    expected_cap = max_concurrency_i
elif pool_capacity:
    expected_cap = pool_capacity
overcommit_delta = None
if max_concurrency_i is not None and pool_capacity is not None:
    overcommit_delta = max_concurrency_i - pool_capacity

uri = f"file:{db_path}?mode=ro"
conn = sqlite3.connect(uri, uri=True, timeout=5)
conn.row_factory = sqlite3.Row

def table_exists(name):
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    return row is not None

status_counts = Counter()
if table_exists("tasks"):
    for row in conn.execute("SELECT status, COUNT(*) AS c FROM tasks GROUP BY status"):
        status_counts[str(row["status"])] = int(row["c"])

running = status_counts.get("running", 0)
pending = status_counts.get("pending", 0)
failed = status_counts.get("failed", 0)

launching = 0
ready_without_dispatch = []
dag_blocked = []
if table_exists("tasks"):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(tasks)")}
    launch_phase_col = "launch_phase" if "launch_phase" in cols else None
    if launch_phase_col:
        launching = conn.execute(
            f"SELECT COUNT(*) FROM tasks WHERE status='pending' AND COALESCE({launch_phase_col}, '')='launching'"
        ).fetchone()[0]
    # Best-effort ready / blocked classification using dependencies JSON.
    if "dependencies" in cols:
        rows = conn.execute(
            """
            SELECT id, status, COALESCE(dependencies, '[]') AS dependencies,
                   COALESCE(selected_attempt_id, '') AS selected_attempt_id,
                   COALESCE(blocked_by, '') AS blocked_by,
                   COALESCE(runner_kind, 'worktree') AS runner_kind
            FROM tasks
            WHERE status = 'pending'
            """
        ).fetchall()
        status_by_id = {
            str(r["id"]): str(r["status"])
            for r in conn.execute("SELECT id, status FROM tasks")
        }
        active_dispatch = set()
        if table_exists("task_launch_dispatch"):
            for r in conn.execute(
                """
                SELECT task_id, attempt_id FROM task_launch_dispatch
                WHERE state IN ('enqueued', 'leased', 'acknowledged')
                """
            ):
                active_dispatch.add((str(r["task_id"]), str(r["attempt_id"] or "")))
                active_dispatch.add((str(r["task_id"]), ""))
        for row in rows:
            if str(row["runner_kind"]) == "merge":
                continue
            deps = json.loads(row["dependencies"] or "[]")
            blocked = False
            for dep in deps:
                dep_status = status_by_id.get(str(dep), "missing")
                if dep_status not in ("completed", "complete", "review_ready", "stale"):
                    blocked = True
                    break
            if row["blocked_by"]:
                blocked = True
            if blocked:
                dag_blocked.append(str(row["id"]))
                continue
            attempt = str(row["selected_attempt_id"] or "")
            has_dispatch = (str(row["id"]), attempt) in active_dispatch or (str(row["id"]), "") in {
                (t, a) for (t, a) in active_dispatch if a == ""
            }
            # More precise: match task_id with optional attempt
            has_dispatch = False
            if table_exists("task_launch_dispatch"):
                q = conn.execute(
                    """
                    SELECT 1 FROM task_launch_dispatch
                    WHERE task_id = ?
                      AND state IN ('enqueued', 'leased', 'acknowledged')
                      AND (? = '' OR attempt_id = ?)
                    LIMIT 1
                    """,
                    (row["id"], attempt, attempt),
                ).fetchone()
                has_dispatch = q is not None
            if not has_dispatch:
                ready_without_dispatch.append(str(row["id"]))

leases = []
expired_leases = []
duplicate_members = []
if table_exists("execution_resource_leases"):
    for row in conn.execute(
        """
        SELECT resource_key, resource_type, holder_id, task_id, pool_member_id,
               lease_expires_at, acquired_at
        FROM execution_resource_leases
        ORDER BY resource_key
        """
    ):
        item = {k: row[k] for k in row.keys()}
        exp = parse_iso(row["lease_expires_at"])
        if exp is not None and exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp is not None and exp <= now:
            expired_leases.append(item)
        else:
            leases.append(item)
    by_attempt = defaultdict(set)
    for item in leases:
        holder = str(item.get("holder_id") or "")
        member = str(item.get("pool_member_id") or item.get("resource_key") or "")
        if item.get("resource_type") == "ssh" and holder and member:
            by_attempt[holder].add(member)
    duplicate_members = [
        {"holderId": holder, "members": sorted(members)}
        for holder, members in by_attempt.items()
        if len(members) > 1
    ]

dispatch_counts = Counter()
if table_exists("task_launch_dispatch"):
    for row in conn.execute("SELECT state, COUNT(*) AS c FROM task_launch_dispatch GROUP BY state"):
        dispatch_counts[str(row["state"])] = int(row["c"])

event_slice = []
if table_exists("events"):
    interesting = (
        "task.executor.deferred",
        "task.execution_resource_lease_released",
        "task.launch_dispatch_lease_released",
        "task.launch_dispatch_invalidated",
        "task.launch_dispatch_reaped",
        "task.dispatch_enqueued",
        "task.launch_claimed",
    )
    placeholders = ",".join("?" for _ in interesting)
    for row in conn.execute(
        f"""
        SELECT task_id, event_type, payload, created_at
        FROM events
        WHERE event_type IN ({placeholders})
        ORDER BY created_at DESC
        LIMIT 40
        """,
        interesting,
    ):
        payload = row["payload"]
        try:
            payload_obj = json.loads(payload) if payload else None
        except json.JSONDecodeError:
            payload_obj = payload
        event_slice.append(
            {
                "taskId": row["task_id"],
                "eventType": row["event_type"],
                "createdAt": row["created_at"],
                "payload": payload_obj,
            }
        )

log_hits = []
if os.path.isfile(log_path):
    keys = (
        "availableSlots",
        "execution-pool-capacity",
        "ssh-resource-lease-held",
        "reclaimed superseded",
        "reclaimed orphaned",
        "released resource leases",
        "drainScheduler",
        "topped up ready",
        "no member capacity",
    )
    try:
        with open(log_path, "rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            fh.seek(max(0, size - 512_000))
            chunk = fh.read().decode("utf-8", errors="replace")
        for line in chunk.splitlines()[-400:]:
            if any(k in line for k in keys):
                log_hits.append(line[:300])
    except OSError:
        pass

occupied = running + launching
verdicts = []
if overcommit_delta is not None and overcommit_delta > 0:
    verdicts.append("config-overcommit")
if expired_leases:
    verdicts.append("lease-orphan")
if duplicate_members:
    verdicts.append("pool-orphan")
if launching > 0 and ready_without_dispatch and occupied < (expected_cap or 0):
    verdicts.append("launching-orphan")
if ready_without_dispatch and (expected_cap is None or occupied < expected_cap):
    verdicts.append("ready-no-dispatch")
if dag_blocked and not ready_without_dispatch and occupied < (expected_cap or occupied + 1):
    verdicts.append("dag-not-ready")
if not verdicts:
    if expected_cap is not None and occupied >= expected_cap:
        verdicts.append("healthy")
    elif ready_without_dispatch:
        verdicts.append("ready-no-dispatch")
    elif dag_blocked:
        verdicts.append("dag-not-ready")
    else:
        verdicts.append("healthy")

report = {
    "dbPath": db_path,
    "logPath": log_path,
    "configPath": config_path,
    "config": {
        "maxConcurrency": max_concurrency_i,
        "poolCapacity": pool_capacity,
        "expectedCap": expected_cap,
        "overcommitDelta": overcommit_delta,
        "poolResources": capacity_by_resource,
    },
    "occupancy": {
        "running": running,
        "launching": launching,
        "pending": pending,
        "failed": failed,
        "occupied": occupied,
        "statusCounts": dict(status_counts),
        "readyWithoutDispatch": ready_without_dispatch[:50],
        "readyWithoutDispatchCount": len(ready_without_dispatch),
        "dagBlockedCount": len(dag_blocked),
        "dagBlockedSample": dag_blocked[:20],
    },
    "leases": {
        "activeCount": len(leases),
        "expiredCount": len(expired_leases),
        "active": leases[:30],
        "expired": expired_leases[:30],
        "duplicateMemberHolders": duplicate_members,
    },
    "dispatch": dict(dispatch_counts),
    "events": event_slice,
    "logHits": log_hits[-40:],
    "verdict": verdicts[0],
    "verdicts": verdicts,
}

if output_json:
    print(json.dumps(report, indent=2, default=str))
else:
    print(f"verdict={report['verdict']}")
    print(f"verdicts={','.join(report['verdicts'])}")
    print(f"maxConcurrency={max_concurrency_i}")
    print(f"poolCapacity={pool_capacity}")
    print(f"expectedCap={expected_cap}")
    print(f"overcommitDelta={overcommit_delta}")
    print(f"running={running}")
    print(f"launching={launching}")
    print(f"occupied={occupied}")
    print(f"readyWithoutDispatch={len(ready_without_dispatch)}")
    print(f"dagBlocked={len(dag_blocked)}")
    print(f"activeLeases={len(leases)}")
    print(f"expiredLeases={len(expired_leases)}")
    print(f"duplicateLeaseHolders={len(duplicate_members)}")
    print(f"dispatch={dict(dispatch_counts)}")
    if ready_without_dispatch[:5]:
        print("readyWithoutDispatchSample=" + ",".join(ready_without_dispatch[:5]))
    if expired_leases[:3]:
        print("expiredLeaseSample=" + ",".join(str(x.get("resource_key")) for x in expired_leases[:3]))
    if log_hits:
        print(f"logHits={len(log_hits)}")
conn.close()
PY
