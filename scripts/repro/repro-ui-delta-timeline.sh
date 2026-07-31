#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$ROOT_DIR/run.sh"
TIMEOUT_SEC="${INVOKER_UI_DELTA_TIMELINE_TIMEOUT_SEC:-240}"
OWNER_PROBE_TIMEOUT_SEC="${INVOKER_UI_DELTA_OWNER_PROBE_TIMEOUT_SEC:-5}"
KEEP_TMP="${INVOKER_UI_DELTA_KEEP_TMP:-0}"

TMP_BASE="${INVOKER_UI_DELTA_TMPDIR:-/tmp}"
TMP_ROOT="$(mktemp -d "$TMP_BASE/invoker-ui-delta-timeline.XXXXXX")"
HOME_DIR="$TMP_ROOT/home"
DB_DIR="$HOME_DIR/.invoker"
LOG_DIR="$TMP_ROOT/logs"
PLAN_PATH="$TMP_ROOT/hello-world.yaml"
CONFIG_PATH="$TMP_ROOT/config.json"
IPC_SOCKET="$TMP_ROOT/i.sock"
FEATURE_BRANCH="plan/ui-delta-timeline-$(date +%s)-$$"
REPO_URL="${INVOKER_UI_DELTA_REPO_URL:-}"

GUI_LOG="$LOG_DIR/gui-launch.log"
RUN_STDOUT="$LOG_DIR/run.stdout.log"
RUN_STDERR="$LOG_DIR/run.stderr.log"
REBASE_STDOUT="$LOG_DIR/rebase-recreate.stdout.log"
REBASE_STDERR="$LOG_DIR/rebase-recreate.stderr.log"
WORKFLOWS_JSON="$LOG_DIR/workflows.json"
WORKFLOW_STATUS_JSON="$LOG_DIR/workflow-status.json"
BACKEND_SOURCE="$DB_DIR/invoker.log"
RENDERER_SOURCE="$DB_DIR/ui-task-graph-events.jsonl"
BACKEND_RAW="$LOG_DIR/backend.raw.log"
RENDERER_RAW="$LOG_DIR/renderer.raw.jsonl"
COMPARISON_JSON="$LOG_DIR/comparison.json"

GUI_PID=""
BACKEND_FOLLOW_PID=""
RENDERER_FOLLOW_PID=""

log() {
  printf '==> %s\n' "$*" >&2
}

fail() {
  KEEP_TMP=1
  printf 'FAIL: %s\n' "$*" >&2
  printf 'Artifacts: %s\n' "$LOG_DIR" >&2
  exit 1
}

cleanup() {
  if [[ -n "$BACKEND_FOLLOW_PID" ]] && kill -0 "$BACKEND_FOLLOW_PID" >/dev/null 2>&1; then
    kill "$BACKEND_FOLLOW_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$RENDERER_FOLLOW_PID" ]] && kill -0 "$RENDERER_FOLLOW_PID" >/dev/null 2>&1; then
    kill "$RENDERER_FOLLOW_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$GUI_PID" ]] && kill -0 "$GUI_PID" >/dev/null 2>&1; then
    kill "$GUI_PID" >/dev/null 2>&1 || true
    wait "$GUI_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$IPC_SOCKET"
  if [[ "$KEEP_TMP" = "1" ]]; then
    printf 'Kept temp repro dir: %s\n' "$TMP_ROOT" >&2
  else
    rm -rf "$TMP_ROOT"
  fi
}
trap cleanup EXIT

COMMON_ENV=(
  HOME="$HOME_DIR"
  INVOKER_DB_DIR="$DB_DIR"
  INVOKER_IPC_SOCKET="$IPC_SOCKET"
  INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
  INVOKER_GUI_OWNER_MODE=gui
  INVOKER_DISABLE_SLACK=1
  INVOKER_TRACE_UI_DELTA=1
  INVOKER_TRACE_RENDERER_TASK_GRAPH=1
)

run_headless() {
  env "${COMMON_ENV[@]}" "$RUNNER" --headless "$@"
}

run_headless_logged_with_timeout() {
  local timeout_sec="$1"
  local stdout_file="$2"
  local stderr_file="$3"
  shift 3

  env "${COMMON_ENV[@]}" python3 - "$timeout_sec" "$stdout_file" "$stderr_file" "$RUNNER" --headless "$@" <<'PY'
import os
import signal
import subprocess
import sys

timeout_sec = float(sys.argv[1])
stdout_file = sys.argv[2]
stderr_file = sys.argv[3]
command = sys.argv[4:]

with open(stdout_file, "w", encoding="utf-8") as stdout, open(stderr_file, "w", encoding="utf-8") as stderr:
    child = subprocess.Popen(
        command,
        stdout=stdout,
        stderr=stderr,
        start_new_session=True,
    )
    try:
        raise SystemExit(child.wait(timeout=timeout_sec))
    except subprocess.TimeoutExpired:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=2)
        except Exception:
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except Exception:
                pass
            child.wait()
        raise SystemExit(124)
PY
}

run_headless_logged() {
  run_headless_logged_with_timeout "$TIMEOUT_SEC" "$@"
}

wait_for_gui_ready() {
  local deadline=$((SECONDS + TIMEOUT_SEC))
  while (( SECONDS < deadline )); do
    if [[ -n "$GUI_PID" ]] && ! kill -0 "$GUI_PID" >/dev/null 2>&1; then
      tail -n 120 "$GUI_LOG" >&2 || true
      fail "GUI process exited before owner startup completed"
    fi

    local owner_pid=""
    if [[ -f "$DB_DIR/invoker.db.lock/pid" ]]; then
      owner_pid="$(cat "$DB_DIR/invoker.db.lock/pid" 2>/dev/null || true)"
    fi
    if [[ -n "$owner_pid" ]] \
      && kill -0 "$owner_pid" >/dev/null 2>&1 \
      && { [[ -S "$IPC_SOCKET" ]] || [[ -e "$IPC_SOCKET" ]]; } \
      && grep -q 'owner-ipc-ready' "$BACKEND_SOURCE" 2>/dev/null \
      && grep -q 'startup phase ui.interactive' "$BACKEND_SOURCE" 2>/dev/null; then
      return 0
    fi

    sleep 1
  done
  tail -n 120 "$GUI_LOG" >&2 || true
  fail "timed out waiting for GUI owner startup"
}

start_log_followers() {
  touch "$BACKEND_SOURCE" "$RENDERER_SOURCE"

tail -n0 -F "$BACKEND_SOURCE" 2>/dev/null | python3 -u -c '
import json, sys
marker = "delta\u2192ui:"
for raw in sys.stdin:
    try:
        row = json.loads(raw)
    except Exception:
        continue
    msg = row.get("msg", "")
    if row.get("module") == "ui" and marker in msg:
        print("[backend delta-ui] " + msg.split(marker, 1)[1].strip(), flush=True)
' &
  BACKEND_FOLLOW_PID="$!"

  tail -n0 -F "$RENDERER_SOURCE" 2>/dev/null | python3 -u -c '
import json, sys
for raw in sys.stdin:
    try:
        row = json.loads(raw)
    except Exception:
        continue
    event = row.get("event", {})
    if event.get("type") != "delta":
        continue
    print("[renderer task-graph-event] " + json.dumps(event.get("delta", {}), separators=(",", ":")), flush=True)
' &
  RENDERER_FOLLOW_PID="$!"
}

parse_workflow_id_from_stdout() {
  local stdout_file="$1"
  sed -nE \
    -e 's/^Workflow ID: (wf-[^[:space:]]+).*/\1/p' \
    -e 's/^Delegated to owner .* workflow: (wf-[^[:space:]]+).*/\1/p' \
    "$stdout_file" | tail -n1
}

discover_workflow_id() {
  local stdout_file="$1"
  local parsed
  parsed="$(parse_workflow_id_from_stdout "$stdout_file")"
  if [[ -n "$parsed" ]]; then
    printf '%s\n' "$parsed"
    return 0
  fi

  run_headless_logged "$WORKFLOWS_JSON" "$LOG_DIR/workflows.stderr.log" query workflows --output json
  python3 - "$WORKFLOWS_JSON" <<'PY'
import json, pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text(errors='ignore')
start = text.find('[')
if start < 0:
    raise SystemExit(1)
workflows = json.loads(text[start:])
matches = [wf for wf in workflows if wf.get('name') == 'UI Delta Timeline Hello World']
if not matches:
    raise SystemExit(1)
matches.sort(key=lambda wf: wf.get('createdAt') or wf.get('updatedAt') or '')
print(matches[-1]['id'])
PY
}

wait_for_workflow_completed() {
  local workflow_id="$1"
  local deadline=$((SECONDS + TIMEOUT_SEC))
  local last_status=""

  while (( SECONDS < deadline )); do
    if run_headless_logged_with_timeout \
      "$OWNER_PROBE_TIMEOUT_SEC" \
      "$WORKFLOW_STATUS_JSON" \
      "$LOG_DIR/workflow-status.stderr.log" \
      query workflows --output json; then
      local result
      result="$(python3 - "$WORKFLOW_STATUS_JSON" "$workflow_id" <<'PY'
import json
import pathlib
import sys

path, workflow_id = sys.argv[1:3]
text = pathlib.Path(path).read_text(errors="ignore")
start = text.find("[")
if start < 0:
    raise SystemExit(1)
workflows = json.loads(text[start:])
workflow = next((item for item in workflows if item.get("id") == workflow_id), None)
if workflow is None:
    raise SystemExit(2)
status = workflow.get("status") or "unknown"
if status in {"completed", "review_ready"}:
    state = "completed"
elif status in {"failed", "closed", "blocked", "needs_input", "awaiting_approval"}:
    state = "terminal"
else:
    state = "waiting"
print(f"{state}\t{status}")
PY
)"

      local state="${result%%$'\t'*}"
      local status="${result#*$'\t'}"
      if [[ "$status" != "$last_status" ]]; then
        log "workflow status: $status"
        last_status="$status"
      fi
      case "$state" in
        completed)
          return 0
          ;;
        terminal)
          fail "workflow $workflow_id finished with status: $status"
          ;;
      esac
    fi
    sleep 1
  done

  fail "timed out waiting for workflow $workflow_id to complete"
}

copy_trace_artifacts() {
  sleep 1
  cp "$BACKEND_SOURCE" "$BACKEND_RAW" 2>/dev/null || : >"$BACKEND_RAW"
  cp "$RENDERER_SOURCE" "$RENDERER_RAW" 2>/dev/null || : >"$RENDERER_RAW"
}

compare_timelines() {
  local workflow_id="$1"
  python3 - "$workflow_id" "$BACKEND_RAW" "$RENDERER_RAW" "$WORKFLOW_STATUS_JSON" "$COMPARISON_JSON" <<'PY'
import copy
import json
import pathlib
import sys

workflow_id, backend_path, renderer_path, workflow_status_path, comparison_path = sys.argv[1:6]
merge_id = f"__merge__{workflow_id}"
hello_suffix = "/hello-world"

def belongs(delta):
    if not isinstance(delta, dict):
        return False
    if delta.get("type") == "created":
        task = delta.get("task") or {}
        task_id = task.get("id")
        task_workflow = (task.get("config") or {}).get("workflowId")
        return task_id == merge_id or task_id == workflow_id or task_workflow == workflow_id or str(task_id or "").startswith(f"{workflow_id}/")
    task_id = str(delta.get("taskId") or "")
    return task_id == merge_id or task_id.startswith(f"{workflow_id}/")

def task_id_for(delta):
    if not isinstance(delta, dict):
        return None
    if delta.get("type") == "created":
        task = delta.get("task") or {}
        task_id = task.get("id")
        return str(task_id) if task_id else None
    task_id = delta.get("taskId")
    return str(task_id) if task_id else None

def is_hello_task_id(task_id):
    return task_id == "hello-world" or str(task_id or "").endswith(hello_suffix)

def nested_get(value, *keys):
    current = value
    for key in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current

def scrub(value):
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items() if k != "streamSequence"}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value

def summarize_delta(delta):
    task_id = task_id_for(delta)
    if not isinstance(delta, dict):
        return None
    if delta.get("type") == "created":
        task = delta.get("task") or {}
        status = task.get("status")
        phase = nested_get(task, "execution", "phase")
        version = task.get("taskStateVersion")
    elif delta.get("type") == "updated":
        changes = delta.get("changes") or {}
        status = changes.get("status")
        phase = nested_get(changes, "execution", "phase")
        version = delta.get("taskStateVersion")
    elif delta.get("type") == "removed":
        status = "removed"
        phase = None
        version = None
    else:
        status = None
        phase = None
        version = None
    return {
        "type": delta.get("type"),
        "taskId": task_id,
        "status": status,
        "phase": phase,
        "taskStateVersion": version,
        "previousTaskStateVersion": delta.get("previousTaskStateVersion"),
        "streamSequence": delta.get("streamSequence"),
    }

def load_backend(path):
    marker = "delta\u2192ui:"
    records = []
    for line_no, raw in enumerate(pathlib.Path(path).read_text(errors="ignore").splitlines(), 1):
        try:
            row = json.loads(raw)
        except Exception:
            continue
        msg = row.get("msg", "")
        if row.get("module") != "ui" or marker not in msg:
            continue
        try:
            delta = json.loads(msg.split(marker, 1)[1].strip())
        except Exception:
            continue
        if belongs(delta):
            records.append({
                "line": line_no,
                "time": row.get("time"),
                "delta": delta,
                "summary": summarize_delta(delta),
                "canonical": scrub(copy.deepcopy(delta)),
            })
    return records

def load_renderer(path):
    records = []
    for line_no, raw in enumerate(pathlib.Path(path).read_text(errors="ignore").splitlines(), 1):
        try:
            row = json.loads(raw)
        except Exception:
            continue
        event = row.get("event") or {}
        if event.get("type") != "delta":
            continue
        delta = event.get("delta")
        if belongs(delta):
            records.append({
                "line": line_no,
                "time": row.get("time"),
                "delta": delta,
                "workflowRollups": event.get("workflowRollups") or [],
                "summary": summarize_delta(delta),
                "canonical": scrub(copy.deepcopy(delta)),
            })
    return records

def merge_task(previous, delta):
    if delta.get("type") == "created":
        task = copy.deepcopy(delta.get("task") or {})
        task_id = task.get("id")
        return str(task_id) if task_id else None, task
    task_id = task_id_for(delta)
    if not task_id:
        return None, None
    if delta.get("type") == "removed":
        return task_id, None
    previous_task = copy.deepcopy(previous.get(task_id) or {"id": task_id, "config": {}, "execution": {}})
    changes = copy.deepcopy(delta.get("changes") or {})
    config_changes = changes.pop("config", None)
    execution_changes = changes.pop("execution", None)
    previous_task.update(changes)
    if config_changes is not None:
        previous_task["config"] = {**(previous_task.get("config") or {}), **config_changes}
    if execution_changes is not None:
        previous_task["execution"] = {**(previous_task.get("execution") or {}), **execution_changes}
    if "taskStateVersion" in delta:
        previous_task["taskStateVersion"] = delta.get("taskStateVersion")
    return task_id, previous_task

def final_task_state(records):
    tasks = {}
    last_seen = {}
    for record in records:
        task_id, task = merge_task(tasks, record["delta"])
        if not task_id:
            continue
        last_seen[task_id] = record["summary"]
        if task is None:
            tasks.pop(task_id, None)
        else:
            tasks[task_id] = task
    return tasks, last_seen

def summarize_task(task, last_seen):
    return {
        "status": task.get("status"),
        "phase": nested_get(task, "execution", "phase"),
        "taskStateVersion": task.get("taskStateVersion"),
        "generation": nested_get(task, "execution", "generation"),
        "workflowId": nested_get(task, "config", "workflowId"),
        "lastStreamSequence": (last_seen or {}).get("streamSequence"),
    }

def summarize_tasks(tasks, last_seen):
    return {
        task_id: summarize_task(task, last_seen.get(task_id))
        for task_id, task in sorted(tasks.items())
    }

def comparable_tasks(summary):
    return {
        task_id: {key: value for key, value in task.items() if key != "lastStreamSequence"}
        for task_id, task in summary.items()
    }

def infer_workflow(tasks):
    statuses = [task.get("status") for task in tasks.values()]
    if not statuses:
        status = "empty"
    elif any(status in {"failed", "blocked"} for status in statuses):
        status = "failed"
    elif any(status in {"running", "fixing_with_ai"} for status in statuses):
        status = "running"
    elif any(status in {"pending", "queued"} for status in statuses):
        status = "pending"
    elif all(status in {"completed", "review_ready", "skipped"} for status in statuses):
        status = "completed"
    else:
        status = "unknown"
    counts = {}
    for status_value in statuses:
        counts[status_value or "unknown"] = counts.get(status_value or "unknown", 0) + 1
    return {"status": status, "countsByStatus": counts, "taskCount": len(statuses)}

def load_backend_workflow(path):
    text = pathlib.Path(path).read_text(errors="ignore")
    start = text.find("[")
    if start < 0:
        return None
    workflows = json.loads(text[start:])
    workflow = next((item for item in workflows if item.get("id") == workflow_id), None)
    if not workflow:
        return None
    return {
        "source": "headless query workflows",
        "id": workflow.get("id"),
        "status": workflow.get("status"),
        "generation": workflow.get("generation"),
        "updatedAt": workflow.get("updatedAt"),
    }

def renderer_workflow_rollup(records):
    latest = None
    for record in records:
        for patch in record.get("workflowRollups") or []:
            if patch.get("workflowId") == workflow_id:
                latest = patch
    if latest is None:
        return None
    rollup = latest.get("rollup") or {}
    return {
        "source": "renderer workflowRollups",
        "id": workflow_id,
        "status": latest.get("status"),
        "removed": latest.get("removed") is True,
        "countsByStatus": rollup.get("countsByStatus"),
    }

def comparable_workflow(state):
    return {
        "status": state.get("status") if isinstance(state, dict) else None,
        "removed": bool(state.get("removed") is True) if isinstance(state, dict) else False,
    }

def delta_has_status(record, status):
    summary = record.get("summary") or {}
    task_id = summary.get("taskId")
    return is_hello_task_id(task_id) and summary.get("status") == status

def removed_hello_ids(records):
    return {
        (record.get("summary") or {}).get("taskId")
        for record in records
        if (record.get("summary") or {}).get("type") == "removed"
        and is_hello_task_id((record.get("summary") or {}).get("taskId"))
    }

def compact_record(record):
    if record is None:
        return None
    return {
        "line": record.get("line"),
        "time": record.get("time"),
        **(record.get("summary") or {}),
    }

def compare_compact(left, right):
    if left is None and right is None:
        return None
    if left is None:
        return "renderer has extra event"
    if right is None:
        return "backend has extra event"
    fields = ["type", "taskId", "status", "phase", "taskStateVersion", "previousTaskStateVersion"]
    mismatched = [field for field in fields if left.get(field) != right.get(field)]
    return ", ".join(mismatched) if mismatched else None

backend = load_backend(backend_path)
renderer = load_renderer(renderer_path)
backend_canonical = [record["canonical"] for record in backend]
renderer_canonical = [record["canonical"] for record in renderer]

first_mismatch = None
for index, (left, right) in enumerate(zip(backend_canonical, renderer_canonical)):
    if left != right:
        first_mismatch = {
            "index": index,
            "backend": backend[index],
            "renderer": renderer[index],
        }
        break

if first_mismatch is None and len(backend_canonical) != len(renderer_canonical):
    index = min(len(backend_canonical), len(renderer_canonical))
    first_mismatch = {
        "index": index,
        "backend": backend[index] if index < len(backend) else None,
        "renderer": renderer[index] if index < len(renderer) else None,
    }

backend_tasks, backend_last_seen = final_task_state(backend)
renderer_tasks, renderer_last_seen = final_task_state(renderer)
backend_summary = summarize_tasks(backend_tasks, backend_last_seen)
renderer_summary = summarize_tasks(renderer_tasks, renderer_last_seen)
backend_workflow = load_backend_workflow(workflow_status_path) or {
    "source": "inferred from backend task deltas",
    **infer_workflow(backend_tasks),
}
renderer_workflow = renderer_workflow_rollup(renderer) or {
    "source": "inferred from renderer task deltas",
    **infer_workflow(renderer_tasks),
}
reasons = []

backend_sent_running = any(delta_has_status(record, "running") for record in backend)
renderer_observed_running = any(delta_has_status(record, "running") for record in renderer)
if backend_sent_running and not renderer_observed_running:
    reasons.append({
        "kind": "missing-renderer-running",
        "message": "backend sent hello-world -> running but renderer never observed running",
        "backendRunningEvents": [compact_record(record) for record in backend if delta_has_status(record, "running")],
    })

backend_removed = removed_hello_ids(backend)
for task_id in sorted(removed_hello_ids(renderer)):
    if task_id not in backend_removed:
        reasons.append({
            "kind": "renderer-removed-without-backend-remove",
            "message": f"renderer emitted removed for {task_id} without a backend remove/delete",
            "taskId": task_id,
        })

if comparable_tasks(backend_summary) != comparable_tasks(renderer_summary):
    reasons.append({
        "kind": "final-task-state-mismatch",
        "message": "final backend and renderer task states disagree",
        "backend": backend_summary,
        "renderer": renderer_summary,
    })

if comparable_workflow(backend_workflow) != comparable_workflow(renderer_workflow):
    reasons.append({
        "kind": "final-workflow-state-mismatch",
        "message": "final backend and renderer workflow states disagree",
        "backend": backend_workflow,
        "renderer": renderer_workflow,
    })

timeline = []
for index in range(max(len(backend), len(renderer))):
    left = compact_record(backend[index]) if index < len(backend) else None
    right = compact_record(renderer[index]) if index < len(renderer) else None
    timeline.append({
        "index": index,
        "backend": left,
        "renderer": right,
        "mismatchReason": compare_compact(left, right),
    })

result = {
    "ok": len(reasons) == 0,
    "workflowId": workflow_id,
    "backendCount": len(backend),
    "rendererCount": len(renderer),
    "acceptanceFailures": reasons,
    "sequenceFirstMismatch": first_mismatch,
    "finalState": {
        "tasks": {
            "backend": backend_summary,
            "renderer": renderer_summary,
        },
        "workflow": {
            "backend": backend_workflow,
            "renderer": renderer_workflow,
        },
    },
    "timeline": timeline,
    "backendLog": backend_path,
    "rendererLog": renderer_path,
}
pathlib.Path(comparison_path).write_text(json.dumps(result, indent=2) + "\n")

if reasons:
    print(json.dumps(result, indent=2), file=sys.stderr)
    raise SystemExit(1)

print(json.dumps(result, indent=2))
PY
}

mkdir -p "$DB_DIR" "$LOG_DIR"
: >"$BACKEND_SOURCE"
: >"$RENDERER_SOURCE"

if [[ -z "$REPO_URL" ]]; then
  REPO_URL="$(git -C "$ROOT_DIR" config --get remote.origin.url || true)"
fi
[[ -n "$REPO_URL" ]] || fail "could not determine repo URL; set INVOKER_UI_DELTA_REPO_URL"

cat >"$CONFIG_PATH" <<'JSON'
{
  "allowGraphMutation": true,
  "disableAutoRunOnStartup": true,
  "maxConcurrency": 1,
  "autoFixRetries": 0
}
JSON

cat >"$PLAN_PATH" <<YAML
name: UI Delta Timeline Hello World
description: Repro fixture for backend-vs-renderer task graph event timelines.
repoUrl: "$REPO_URL"
featureBranch: "$FEATURE_BRANCH"
onFinish: none
tasks:
  - id: hello-world
    description: hello world
    command: echo hello world
    dependencies: []
YAML

[[ -x "$RUNNER" ]] || fail "missing executable runner at $RUNNER"

cd "$ROOT_DIR"
log "temp repro dir: $TMP_ROOT"
log "starting traced GUI with isolated state; ./run.sh may stop existing Invoker Electron processes"
env "${COMMON_ENV[@]}" "$RUNNER" . >"$GUI_LOG" 2>&1 &
GUI_PID="$!"

wait_for_gui_ready
log "GUI owner is reachable"

start_log_followers

log "loading and running hello-world plan"
if ! run_headless_logged "$RUN_STDOUT" "$RUN_STDERR" run "$PLAN_PATH"; then
  tail -n 120 "$RUN_STDERR" >&2 || true
  fail "hello-world run failed"
fi

WORKFLOW_ID="$(discover_workflow_id "$RUN_STDOUT")"
[[ -n "$WORKFLOW_ID" ]] || fail "could not discover workflow id"
log "workflow id: $WORKFLOW_ID"

log "running rebase-recreate and following until settled"
if ! run_headless_logged "$REBASE_STDOUT" "$REBASE_STDERR" rebase-recreate "$WORKFLOW_ID"; then
  tail -n 160 "$REBASE_STDERR" >&2 || true
  fail "rebase-recreate failed"
fi
wait_for_workflow_completed "$WORKFLOW_ID"

copy_trace_artifacts
log "comparing backend delta-ui timeline with renderer task-graph-event timeline"
if ! compare_timelines "$WORKFLOW_ID"; then
  fail "backend and renderer task-delta timelines diverged"
fi

log "timeline comparison passed"
printf 'workflow: %s\n' "$WORKFLOW_ID"
printf 'comparison: %s\n' "$COMPARISON_JSON"
printf 'backend log: %s\n' "$BACKEND_RAW"
printf 'renderer log: %s\n' "$RENDERER_RAW"
