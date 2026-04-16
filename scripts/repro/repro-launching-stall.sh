#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
REMOTE_REPO="$TMP_DIR/remote.git"
CONFIG_PATH="$TMP_DIR/config.json"
WORKFLOW_COUNT="${WORKFLOW_COUNT:-3}"
ROUNDS="${ROUNDS:-6}"
LAUNCHING_THRESHOLD_SEC="${LAUNCHING_THRESHOLD_SEC:-20}"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/headless-client.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

git init --bare "$REMOTE_REPO" >/dev/null 2>&1

cat > "$CONFIG_PATH" <<'EOF'
{"autoFixRetries":0,"maxConcurrency":6}
EOF

COMMON_ENV=(
  HOME="$HOME_DIR"
  INVOKER_DB_DIR="$DB_DIR"
  INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
  INVOKER_HEADLESS_STANDALONE=1
)
export HOME="$HOME_DIR"
export INVOKER_DB_DIR="$DB_DIR"
export INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
export INVOKER_HEADLESS_STANDALONE=1

extract_workflow_id() {
  sed -n 's/^Workflow ID: //p' "$1" | head -n1
}

create_plan() {
  local idx="$1"
  local plan_path="$TMP_DIR/plan-$idx.yaml"
  cat > "$plan_path" <<EOF
name: launching-stall-repro-$idx
onFinish: none
repoUrl: file://$REMOTE_REPO
tasks:
  - id: root
    description: Keep task active during restart burst
    command: sleep 5
EOF
  echo "$plan_path"
}

echo "repro: creating $WORKFLOW_COUNT workflows in isolated DB..."
declare -a WORKFLOW_IDS=()
for idx in $(seq 1 "$WORKFLOW_COUNT"); do
  plan_path="$(create_plan "$idx")"
  run_stdout="$TMP_DIR/run-$idx.stdout.log"
  run_stderr="$TMP_DIR/run-$idx.stderr.log"
  env "${COMMON_ENV[@]}" ./run.sh --headless --no-track run "$plan_path" >"$run_stdout" 2>"$run_stderr"
  wf_id="$(extract_workflow_id "$run_stdout")"
  if [[ -z "$wf_id" ]]; then
    echo "repro: failed to create workflow id for plan $idx" >&2
    cat "$run_stdout" >&2 || true
    cat "$run_stderr" >&2 || true
    exit 1
  fi
  WORKFLOW_IDS+=("$wf_id")
done

if [[ "${#WORKFLOW_IDS[@]}" -lt 2 ]]; then
  echo "repro: expected at least 2 workflows, got ${#WORKFLOW_IDS[@]}" >&2
  exit 1
fi

LOG_PATH="$DB_DIR/invoker.log"
START_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "repro: stress restarting workflows with --no-track..."
for round in $(seq 1 "$ROUNDS"); do
  for wf_id in "${WORKFLOW_IDS[@]}"; do
    env "${COMMON_ENV[@]}" ./run.sh --headless --no-track restart "$wf_id" \
      >"$TMP_DIR/restart-${round}-${wf_id}.stdout.log" \
      2>"$TMP_DIR/restart-${round}-${wf_id}.stderr.log" &
  done
  wait
done

sleep 2

echo "repro: analyzing logs and task states..."
python3 - "$LOG_PATH" "$START_TIME" "$LAUNCHING_THRESHOLD_SEC" "${WORKFLOW_IDS[@]}" <<'PY'
import json
import subprocess
import sys
from datetime import datetime, timezone

log_path = sys.argv[1]
start_time = datetime.fromisoformat(sys.argv[2].replace("Z", "+00:00"))
launching_threshold_sec = int(sys.argv[3])
workflow_ids = sys.argv[4:]

def parse_ts(value: str) -> datetime:
    if "." not in value:
        value = value.replace("Z", ".000Z")
    return datetime.strptime(value, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=timezone.utc)

drop_msgs = []
dispatch_msgs = []
with open(log_path, "r", encoding="utf-8") as f:
    for line in f:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            row = json.loads(line)
        except Exception:
            continue
        msg = row.get("msg", "")
        t = row.get("time")
        if not t:
            continue
        try:
            ts = parse_ts(t)
        except Exception:
            continue
        if ts < start_time:
            continue
        if "dropped cross-workflow runnable tasks for" in msg:
            drop_msgs.append((t, msg))
        if "dispatching cross-workflow runnable tasks for" in msg:
            dispatch_msgs.append((t, msg))

now = datetime.now(timezone.utc)
stuck = []

def extract_json(payload: str):
    for line in reversed(payload.splitlines()):
        line = line.strip()
        if line.startswith("{") or line.startswith("["):
            try:
                return json.loads(line)
            except Exception:
                continue
    return []

for wf_id in workflow_ids:
    cmd = [
        "./run.sh", "--headless", "query", "tasks",
        "--workflow", wf_id, "--output", "json",
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, env=None, check=False)
    tasks = extract_json(proc.stdout)
    if not isinstance(tasks, list):
        continue
    for task in tasks:
        if task.get("status") != "running":
            continue
        execution = task.get("execution") or {}
        if execution.get("phase") != "launching":
            continue
        started = execution.get("launchStartedAt") or execution.get("startedAt")
        if not started:
            continue
        try:
            started_ts = datetime.fromisoformat(started.replace("Z", "+00:00"))
        except Exception:
            continue
        age = (now - started_ts).total_seconds()
        if age >= launching_threshold_sec:
            stuck.append((task.get("id", "<unknown>"), int(age)))

print("repro-summary:")
print(f"  start_time: {start_time.isoformat()}")
print(f"  dropped_cross_workflow_events: {len(drop_msgs)}")
print(f"  dispatching_cross_workflow_events: {len(dispatch_msgs)}")
print(f"  running_launching_over_threshold: {len(stuck)} (threshold={launching_threshold_sec}s)")

if drop_msgs:
    print("  sample_dropped_event:")
    print(f"    {drop_msgs[0][0]} {drop_msgs[0][1]}")
if dispatch_msgs:
    print("  sample_dispatch_event:")
    print(f"    {dispatch_msgs[0][0]} {dispatch_msgs[0][1]}")
if stuck:
    print("  sample_stuck_task:")
    print(f"    {stuck[0][0]} age={stuck[0][1]}s")

# Fail baseline when drops occur or tasks remain launching too long.
if drop_msgs or stuck:
    sys.exit(1)
PY

echo "repro: PASS (no cross-workflow drops, no prolonged launching tasks)"
