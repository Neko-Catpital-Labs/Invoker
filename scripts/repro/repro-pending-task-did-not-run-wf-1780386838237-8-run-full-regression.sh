#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-wf-1780386838237-8-run-full-regression.XXXXXX.log")"
state_file="$(mktemp "${TMPDIR:-/tmp}/invoker-wf-1780386838237-8-run-full-regression-state.XXXXXX.tsv")"
trap 'rm -f "$log_file" "$state_file"' EXIT

echo "[repro] wf-1780386838237-8/run-full-regression dependencies were complete and the task was queued."
echo "[repro] Launch attempts were repeatedly deferred by pnpm-ssh resource leases / pool capacity before executor selection."
echo "[repro] The diagnostic condition is a stale SSH execution-resource lease from an older cancelled attempt consuming a pool member."

python3 <<'PY'
import sqlite3

TASK_ID = "wf-1780386838237-8/run-full-regression"
OLD_ATTEMPT = "wf-1780386838237-8/run-full-regression-a84a0aaa8"
NEW_ATTEMPT = "wf-1780386838237-8/run-full-regression-ab7333ae8"

task = {
    "id": TASK_ID,
    "status": "pending",
    "config": {"workflowId": "wf-1780386838237-8", "runnerKind": "ssh", "poolId": "pnpm-ssh"},
    "execution": {"lastHeartbeatAt": "2026-06-04T23:04:46.711Z"},
}
queue = {
    "maxConcurrency": 12,
    "runningCount": 2,
    "queued": [{"taskId": TASK_ID}],
    "running": [
        {"taskId": "wf-1780385813241-5/capture-after-visual-proof"},
        {"taskId": "wf-1778825464672-5/final-regression-ui-bundle-splitting"},
    ],
}
audit_reasons = {
    "ssh-resource-lease-held",
    "execution-pool-capacity",
}

assert task["status"] == "pending"
assert TASK_ID in {row["taskId"] for row in queue["queued"]}
assert {"ssh-resource-lease-held", "execution-pool-capacity"} <= audit_reasons

conn = sqlite3.connect(":memory:")
conn.execute(
    """
    CREATE TABLE execution_resource_leases (
      resource_key TEXT,
      resource_type TEXT,
      holder_id TEXT,
      task_id TEXT,
      pool_id TEXT,
      pool_member_id TEXT,
      lease_expires_at TEXT,
      PRIMARY KEY(resource_key, holder_id)
    )
    """
)

def holder(attempt):
    return f"a39a9582-9db7-460f-b04a-110aefd04e55:81568:{TASK_ID}:{attempt}"

conn.execute(
    """
    INSERT INTO execution_resource_leases
      (resource_key, resource_type, holder_id, task_id, pool_id, pool_member_id, lease_expires_at)
    VALUES (?, 'ssh', ?, ?, 'pnpm-ssh', 'remote_digital_ocean_4', '2099-01-01T00:20:00Z')
    """,
    ("ssh:invoker@138.68.230.225:22", holder(OLD_ATTEMPT), TASK_ID),
)

def claim_resource(resource_key, holder_id):
    active = conn.execute(
        """
        SELECT holder_id
          FROM execution_resource_leases
         WHERE resource_key = ?
           AND holder_id != ?
           AND lease_expires_at > '2026-06-04T23:04:17.000Z'
         LIMIT 1
        """,
        (resource_key, holder_id),
    ).fetchone()
    if active:
        return False
    conn.execute(
        """
        INSERT OR REPLACE INTO execution_resource_leases
          (resource_key, resource_type, holder_id, task_id, pool_id, pool_member_id, lease_expires_at)
        VALUES (?, 'ssh', ?, ?, 'pnpm-ssh', 'remote_digital_ocean_4', '2099-01-01T00:20:00Z')
        """,
        (resource_key, holder_id, TASK_ID),
    )
    return True

resource_key = "ssh:invoker@138.68.230.225:22"
new_holder = holder(NEW_ATTEMPT)
pre_fix_launch_blocked = not claim_resource(resource_key, new_holder)
assert pre_fix_launch_blocked

released = conn.execute(
    """
    DELETE FROM execution_resource_leases
     WHERE task_id = ?
       AND holder_id != ?
    """,
    (TASK_ID, new_holder),
).rowcount
assert released == 1
post_fix_launch_can_claim = claim_resource(resource_key, new_holder)
assert post_fix_launch_can_claim

print("[repro] pre-fix: stale old-attempt SSH lease blocks the new launch claim")
print("[repro] post-fix: releasing orphan/stale task leases lets the new attempt claim the pool member")
print("[repro] queued pending task with no launch metadata is capacity-blocked work, not a code-generation failure")
PY

INVOKER_RETRY_PENDING_AUTOFIX_STATE_FILE="$state_file" \
  scripts/retry-pending-autofix-failed.sh --self-test | tee "$log_file"

grep -Fq "self-test: active SSH lease for pending task is released" "$log_file"
grep -Fq "self-test: active SSH lease for old attempt on running task is released" "$log_file"
grep -Fq "self-test: queue-active pending task after pool deferral is treated as blocker" "$log_file"
grep -Fq "self-test: all passed" "$log_file"

echo "[repro] passed"
