#!/usr/bin/env bash
# Capacity monkey: forensic audit + deterministic repros + utilization guarantee.
#
# Modes:
#   INVOKER_MONKEY_CAPACITY_MODE=matrix (default) — deterministic gate suite
#   INVOKER_MONKEY_CAPACITY_MODE=soak            — repeat matrix with utilization watchdog
#
# Isolation: never touches ~/.invoker by default. Optional live audit:
#   INVOKER_MONKEY_AUDIT_LIVE=1 bash scripts/repro/runner-capacity-monkey.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

MODE="${INVOKER_MONKEY_CAPACITY_MODE:-matrix}"
EXPECTED_CAP="${INVOKER_MONKEY_EXPECTED_CAP:-13}"
SOAK_ROUNDS="${INVOKER_MONKEY_SOAK_ROUNDS:-5}"
RESULT_ROOT="${INVOKER_MONKEY_CAPACITY_RESULT_ROOT:-$ROOT/.tmp/monkey-capacity-$$}"
mkdir -p "$RESULT_ROOT"
RESULTS_FILE="$RESULT_ROOT/results.jsonl"
: > "$RESULTS_FILE"

log() { printf '[monkey-capacity] %s\n' "$*"; }

record() {
  local name="$1" status="$2" detail="$3"
  python3 - "$RESULTS_FILE" "$name" "$status" "$detail" <<'PY'
import json, sys, time
path, name, status, detail = sys.argv[1:5]
with open(path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps({
        "ts": time.time(),
        "name": name,
        "status": status,
        "detail": detail,
    }) + "\n")
PY
  log "$status $name — $detail"
}

run_step() {
  local name="$1"
  shift
  local log_file="$RESULT_ROOT/${name}.log"
  if "$@" >"$log_file" 2>&1; then
    record "$name" "PASS" "ok"
    return 0
  fi
  record "$name" "FAIL" "see $log_file"
  return 1
}

chmod +x \
  scripts/repro/capacity-audit.sh \
  scripts/repro/repro-cross-task-pool-orphan-capacity-wedge.sh \
  scripts/repro/repro-restart-expired-ssh-lease-sweep.sh \
  scripts/repro/repro-capacity-fill-13-after-recreate-churn.sh \
  scripts/repro/repro-underfilled-capacity-ready-pending-no-dispatch.sh \
  2>/dev/null || true

failures=0

if [ "${INVOKER_MONKEY_AUDIT_LIVE:-0}" = "1" ]; then
  log "live forensic audit (read-only)"
  if bash scripts/repro/capacity-audit.sh --json >"$RESULT_ROOT/live-audit.json"; then
    verdict="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["verdict"])' "$RESULT_ROOT/live-audit.json")"
    record "live-audit" "PASS" "verdict=$verdict"
  else
    record "live-audit" "FAIL" "capacity-audit exited non-zero"
    failures=$((failures + 1))
  fi
fi

# Synthetic underfill DB → audit must classify ready-no-dispatch / occupancy.
log "synthetic capacity-audit smoke"
SYN_DB="$RESULT_ROOT/synthetic.db"
SYN_CFG="$RESULT_ROOT/synthetic-config.json"
python3 - "$SYN_DB" "$SYN_CFG" "$EXPECTED_CAP" <<'PY'
import json, sqlite3, sys
db_path, cfg_path, expected = sys.argv[1], sys.argv[2], int(sys.argv[3])
# Live-shaped config: maxConcurrency often overcommits pool (13 vs 12).
cfg = {
  "maxConcurrency": expected,
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
with open(cfg_path, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh)
con = sqlite3.connect(db_path)
con.executescript("""
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
""")
# Live-shaped load: ~51 workflows / ~162 tasks (avg ~3.2), underfilled occupancy.
workflow_count = 51
depths = [9] + [5] * 4 + [4] * 6 + [3] * (workflow_count - 11)
task_count = 0
running_budget = 4  # underfill vs expected 13
ready_without_dispatch = 0
for wi, depth in enumerate(depths):
    wf = f"wf-live-{wi}"
    con.execute(
        "INSERT INTO workflows VALUES (?,?,?,?)",
        (wf, wf, "2026-07-16T00:00:00.000Z", "2026-07-16T00:00:00.000Z"),
    )
    for ti in range(depth):
        task_id = f"{wf}/t{ti}"
        deps = json.dumps([f"{wf}/t{ti-1}"] if ti > 0 else [])
        if ti == 0 and running_budget > 0:
            status, phase, member = "running", "executing", f"m{running_budget}"
            running_budget -= 1
        elif ti == 0:
            status, phase, member = "pending", None, None
            ready_without_dispatch += 1
        else:
            # DAG-blocked pending downstream (dominant live shape)
            status, phase, member = "pending", None, None
        con.execute(
            "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?)",
            (task_id, wf, status, "ssh", member, deps, f"{task_id}-a1", phase, ""),
        )
        task_count += 1
        if status == "pending" and ti == 0:
            con.execute(
                "INSERT INTO events VALUES (NULL,?,?,?,?)",
                (task_id, "task.executor.deferred",
                 json.dumps({"reason": "execution-pool-capacity"}),
                 "2026-07-16T00:00:00.000Z"),
            )
# Historical abandoned dispatch noise like production (~large)
for i in range(200):
    con.execute(
        "INSERT INTO task_launch_dispatch VALUES (NULL,?,?,?,?)",
        (f"wf-live-0/t0", f"old-attempt-{i}", "wf-live-0", "abandoned"),
    )
con.execute(
    "INSERT INTO execution_resource_leases VALUES (?,?,?,?,?,?,?)",
    ("ssh:expired", "ssh", "dead", "wf-x/t", "mx", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"),
)
con.commit()
meta = {"workflow_count": workflow_count, "task_count": task_count, "ready_without_dispatch": ready_without_dispatch}
print(json.dumps(meta))
con.close()
PY

if INVOKER_DB_PATH="$SYN_DB" INVOKER_CONFIG_PATH="$SYN_CFG" \
  bash scripts/repro/capacity-audit.sh --json >"$RESULT_ROOT/synthetic-audit.json"; then
  verdict="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["verdict"])' "$RESULT_ROOT/synthetic-audit.json")"
  python3 - "$RESULT_ROOT/synthetic-audit.json" "$EXPECTED_CAP" <<'PY'
import json, sys
report = json.load(open(sys.argv[1]))
expected = int(sys.argv[2])
# Pool is 12 (6 ssh + 6 worktree); maxConcurrency 13 → overcommit + underfill.
assert report["config"]["maxConcurrency"] == expected, report["config"]
assert report["config"]["poolCapacity"] == 12, report["config"]
assert report["occupancy"]["readyWithoutDispatchCount"] >= 20, report["occupancy"]
assert report["occupancy"]["pending"] >= 100, report["occupancy"]
assert "ready-no-dispatch" in report["verdicts"] or "config-overcommit" in report["verdicts"], report["verdicts"]
assert report["leases"]["expiredCount"] >= 1, report["leases"]
print("synthetic live-scale audit invariants ok", {
  "pending": report["occupancy"]["pending"],
  "ready": report["occupancy"]["readyWithoutDispatchCount"],
  "verdicts": report["verdicts"],
})
PY
  record "synthetic-audit" "PASS" "verdict=$verdict"
else
  record "synthetic-audit" "FAIL" "audit failed"
  failures=$((failures + 1))
fi

run_matrix_once() {
  local round_label="$1"
  local ok=0
  run_step "${round_label}-config-overcommit" \
    bash scripts/repro/repro-config-overcommit-live-scale.sh --gate || ok=1
  run_step "${round_label}-lease-orphan" \
    bash scripts/repro/repro-lease-orphan-expired-ssh-live-scale.sh --gate || ok=1
  run_step "${round_label}-cross-task-orphan" \
    bash scripts/repro/repro-cross-task-pool-orphan-live-scale.sh --gate || ok=1
  run_step "${round_label}-ready-no-dispatch" \
    bash scripts/repro/repro-ready-no-dispatch-live-scale.sh --gate || ok=1
  run_step "${round_label}-fill-13" \
    bash scripts/repro/repro-capacity-fill-13-after-recreate-churn.sh || ok=1
  run_step "${round_label}-headless-surface" \
    bash scripts/repro/repro-headless-launch-dispatcher-orchestrator-surface.sh --expect fixed --gate || ok=1
  run_step "${round_label}-underfill-classifier" \
    bash scripts/repro/repro-underfilled-capacity-ready-pending-no-dispatch.sh || ok=1
  run_step "${round_label}-execution-capacity-unit" \
    bash -c 'cd packages/app && pnpm exec vitest run src/__tests__/execution-capacity.test.ts' || ok=1
  run_step "${round_label}-launch-dispatcher-capacity" \
    bash -c 'cd packages/app && pnpm exec vitest run src/__tests__/launch-dispatcher.test.ts -t "capacity recovery"' || ok=1
  return "$ok"
}

log "mode=$MODE expectedCap=$EXPECTED_CAP resultRoot=$RESULT_ROOT"

if [ "$MODE" = "soak" ]; then
  for ((round=1; round<=SOAK_ROUNDS; round++)); do
    log "soak round $round/$SOAK_ROUNDS"
    if ! run_matrix_once "soak${round}"; then
      failures=$((failures + 1))
    fi
  done
else
  if ! run_matrix_once "matrix"; then
    failures=$((failures + 1))
  fi
fi

python3 - "$RESULTS_FILE" "$RESULT_ROOT/summary.json" <<'PY'
import json, sys
from collections import Counter
path, out = sys.argv[1], sys.argv[2]
rows = [json.loads(line) for line in open(path, encoding="utf-8") if line.strip()]
counts = Counter(r["status"] for r in rows)
summary = {"total": len(rows), "counts": dict(counts), "failed": [r for r in rows if r["status"] == "FAIL"]}
json.dump(summary, open(out, "w", encoding="utf-8"), indent=2)
print(json.dumps(summary, indent=2))
PY

if [ "$failures" -gt 0 ]; then
  log "FAILED with $failures failing group(s); results in $RESULT_ROOT"
  exit 1
fi
log "PASS expectedCap=$EXPECTED_CAP utilization gates green; results in $RESULT_ROOT"
