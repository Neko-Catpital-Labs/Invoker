#!/usr/bin/env bash
# Proof: web workflows-changed events lag behind task-graph-events by ~2s.
#
# Product invariant: docs/architecture/ui-action-responsiveness-invariant.md
# requires user-visible ack p95 ≤ 200ms. For the web surface, mutation →
# matching SSE event is the ack. This repro proves that `invoker:workflows-changed`
# events currently arrive ~500–2000ms after the corresponding task-graph-event
# delta because the web bridge polls `listWorkflows` on a 2s interval instead
# of pushing on change like the desktop surface does.
#
# Expected result on master: FAIL (lag ≥ 500ms)
# Expected result after fix: PASS (lag p95 ≤ 200ms)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$ROOT_DIR/run.sh"
TIMEOUT_SEC="${INVOKER_WEB_LAG_TIMEOUT_SEC:-120}"
KEEP_TMP="${INVOKER_WEB_LAG_KEEP_TMP:-0}"
LAG_THRESHOLD_MS="${INVOKER_WEB_LAG_THRESHOLD_MS:-500}"

TMP_BASE="${INVOKER_WEB_LAG_TMPDIR:-/tmp}"
TMP_ROOT="$(mktemp -d "$TMP_BASE/invoker-web-workflows-lag.XXXXXX")"
HOME_DIR="$TMP_ROOT/home"
DB_DIR="$HOME_DIR/.invoker"
LOG_DIR="$TMP_ROOT/logs"
PLAN_PATH="$TMP_ROOT/hello-world.yaml"
CONFIG_PATH="$TMP_ROOT/config.json"
IPC_SOCKET="$TMP_ROOT/i.sock"
FEATURE_BRANCH="plan/web-lag-$(date +%s)-$$"
REPO_URL="${INVOKER_WEB_LAG_REPO_URL:-}"

WEB_TOKEN="test-token-$$"
WEB_PORT="${INVOKER_WEB_PORT:-0}"

OWNER_LOG="$LOG_DIR/owner.log"
SSE_LOG="$LOG_DIR/sse-events.jsonl"
COMPARISON_JSON="$LOG_DIR/comparison.json"

OWNER_PID=""
SSE_PID=""

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
  if [[ -n "$SSE_PID" ]] && kill -0 "$SSE_PID" >/dev/null 2>&1; then
    kill "$SSE_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "$OWNER_PID" ]] && kill -0 "$OWNER_PID" >/dev/null 2>&1; then
    kill "$OWNER_PID" >/dev/null 2>&1 || true
    wait "$OWNER_PID" >/dev/null 2>&1 || true
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
  INVOKER_DISABLE_SLACK=1
  INVOKER_WEB_TOKEN="$WEB_TOKEN"
  INVOKER_WEB_HOST="127.0.0.1"
  INVOKER_WEB_PORT="$WEB_PORT"
)

run_headless() {
  env "${COMMON_ENV[@]}" "$RUNNER" --headless "$@"
}

wait_for_owner_ready() {
  local deadline=$((SECONDS + TIMEOUT_SEC))
  while (( SECONDS < deadline )); do
    if [[ -n "$OWNER_PID" ]] && ! kill -0 "$OWNER_PID" >/dev/null 2>&1; then
      tail -n 60 "$OWNER_LOG" >&2 || true
      fail "Owner process exited before startup completed"
    fi

    local owner_pid=""
    if [[ -f "$DB_DIR/invoker.db.lock/pid" ]]; then
      owner_pid="$(cat "$DB_DIR/invoker.db.lock/pid" 2>/dev/null || true)"
    fi
    if [[ -n "$owner_pid" ]] \
      && kill -0 "$owner_pid" >/dev/null 2>&1 \
      && { [[ -S "$IPC_SOCKET" ]] || [[ -e "$IPC_SOCKET" ]]; } \
      && grep -q 'Web surface listening' "$OWNER_LOG" 2>/dev/null; then
      return 0
    fi

    sleep 0.5
  done
  tail -n 60 "$OWNER_LOG" >&2 || true
  fail "Timed out waiting for owner startup"
}

extract_web_port() {
  sed -nE 's/.*Web surface listening on http:\/\/[^:]+:([0-9]+).*/\1/p' "$OWNER_LOG" | tail -n1
}

start_sse_listener() {
  local port="$1"
  python3 - "$port" "$WEB_TOKEN" "$SSE_LOG" <<'PY' &
import json
import sys
import time
import urllib.request

port, token, log_path = sys.argv[1:4]
url = f"http://127.0.0.1:{port}/events"

req = urllib.request.Request(url, headers={"x-invoker-token": token})
with open(log_path, "w", encoding="utf-8") as log:
    with urllib.request.urlopen(req, timeout=120) as resp:
        event_type = None
        data_lines = []
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
            now_ms = int(time.time() * 1000)
            if line.startswith("event:"):
                event_type = line[6:].strip()
            elif line.startswith("data:"):
                data_lines.append(line[5:].strip())
            elif line == "":
                if event_type and data_lines:
                    try:
                        data = json.loads("".join(data_lines))
                    except Exception:
                        data = {"raw": "".join(data_lines)}
                    record = {
                        "receivedAtMs": now_ms,
                        "event": event_type,
                        "data": data,
                    }
                    log.write(json.dumps(record) + "\n")
                    log.flush()
                event_type = None
                data_lines = []
PY
  SSE_PID="$!"
}

parse_workflow_id_from_stdout() {
  local stdout_file="$1"
  sed -nE \
    -e 's/^Workflow ID: (wf-[^[:space:]]+).*/\1/p' \
    -e 's/^Delegated to owner .* workflow: (wf-[^[:space:]]+).*/\1/p' \
    "$stdout_file" | tail -n1
}

compare_event_timing() {
  local workflow_id="$1"
  python3 - "$workflow_id" "$SSE_LOG" "$COMPARISON_JSON" "$LAG_THRESHOLD_MS" <<'PY'
import json
import pathlib
import sys

workflow_id, sse_log_path, comparison_path, threshold_ms_str = sys.argv[1:5]
threshold_ms = int(threshold_ms_str)

sse_events = []
for line in pathlib.Path(sse_log_path).read_text(errors="ignore").splitlines():
    try:
        sse_events.append(json.loads(line))
    except Exception:
        continue

task_graph_events = []
workflows_changed_events = []

for record in sse_events:
    event = record.get("event", "")
    received_at = record.get("receivedAtMs", 0)
    data = record.get("data", {})
    
    if event == "invoker:task-graph-event":
        delta = data.get("delta", {})
        delta_type = delta.get("type")
        if delta_type == "created":
            task = delta.get("task", {})
            task_workflow_id = (task.get("config") or {}).get("workflowId")
            if task_workflow_id == workflow_id:
                task_graph_events.append({
                    "receivedAtMs": received_at,
                    "type": "created",
                    "taskId": task.get("id"),
                    "status": task.get("status"),
                })
        elif delta_type == "updated":
            task_id = delta.get("taskId", "")
            if task_id.startswith(f"{workflow_id}/"):
                changes = delta.get("changes", {})
                task_graph_events.append({
                    "receivedAtMs": received_at,
                    "type": "updated",
                    "taskId": task_id,
                    "status": changes.get("status"),
                })
    
    elif event == "invoker:workflows-changed":
        workflows = data if isinstance(data, list) else []
        matching = [w for w in workflows if w.get("id") == workflow_id]
        if matching:
            wf = matching[0]
            workflows_changed_events.append({
                "receivedAtMs": received_at,
                "workflowId": wf.get("id"),
                "status": wf.get("status"),
            })

if not task_graph_events:
    result = {
        "ok": False,
        "reason": "no task-graph-events received for workflow",
        "workflowId": workflow_id,
        "taskGraphEventCount": 0,
        "workflowsChangedEventCount": len(workflows_changed_events),
    }
    pathlib.Path(comparison_path).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2), file=sys.stderr)
    raise SystemExit(1)

first_task_event_ms = min(e["receivedAtMs"] for e in task_graph_events)
first_workflow_event_ms = min(
    (e["receivedAtMs"] for e in workflows_changed_events),
    default=None
)

if first_workflow_event_ms is None:
    result = {
        "ok": False,
        "reason": "no workflows-changed events received for workflow",
        "workflowId": workflow_id,
        "taskGraphEventCount": len(task_graph_events),
        "workflowsChangedEventCount": 0,
        "firstTaskEventMs": first_task_event_ms,
    }
    pathlib.Path(comparison_path).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2), file=sys.stderr)
    raise SystemExit(1)

lag_ms = first_workflow_event_ms - first_task_event_ms

lags = []
for tge in task_graph_events:
    tge_ms = tge["receivedAtMs"]
    later_wce = [w for w in workflows_changed_events if w["receivedAtMs"] >= tge_ms]
    if later_wce:
        first_later = min(w["receivedAtMs"] for w in later_wce)
        lags.append(first_later - tge_ms)

if lags:
    lags_sorted = sorted(lags)
    min_lag = lags_sorted[0]
    p50_idx = len(lags_sorted) // 2
    p95_idx = int(len(lags_sorted) * 0.95)
    max_lag = lags_sorted[-1]
    p50_lag = lags_sorted[p50_idx]
    p95_lag = lags_sorted[min(p95_idx, len(lags_sorted) - 1)]
else:
    min_lag = lag_ms
    p50_lag = lag_ms
    p95_lag = lag_ms
    max_lag = lag_ms

exceeds_threshold = p95_lag > threshold_ms

result = {
    "ok": not exceeds_threshold,
    "workflowId": workflow_id,
    "taskGraphEventCount": len(task_graph_events),
    "workflowsChangedEventCount": len(workflows_changed_events),
    "firstTaskEventMs": first_task_event_ms,
    "firstWorkflowEventMs": first_workflow_event_ms,
    "lagMs": {
        "min": min_lag,
        "p50": p50_lag,
        "p95": p95_lag,
        "max": max_lag,
    },
    "thresholdMs": threshold_ms,
    "exceedsThreshold": exceeds_threshold,
    "taskGraphEvents": task_graph_events[:10],
    "workflowsChangedEvents": workflows_changed_events[:10],
}

pathlib.Path(comparison_path).write_text(json.dumps(result, indent=2) + "\n")

if exceeds_threshold:
    print(json.dumps(result, indent=2), file=sys.stderr)
    raise SystemExit(1)

print(json.dumps(result, indent=2))
PY
}

mkdir -p "$DB_DIR" "$LOG_DIR"

if [[ -z "$REPO_URL" ]]; then
  REPO_URL="$(git -C "$ROOT_DIR" config --get remote.origin.url || true)"
fi
[[ -n "$REPO_URL" ]] || fail "Could not determine repo URL; set INVOKER_WEB_LAG_REPO_URL"

cat >"$CONFIG_PATH" <<'JSON'
{
  "allowGraphMutation": true,
  "disableAutoRunOnStartup": true,
  "maxConcurrency": 1,
  "autoFixRetries": 0
}
JSON

cat >"$PLAN_PATH" <<YAML
name: Web Workflows Lag Repro
description: Repro fixture for web workflows-changed lag measurement.
repoUrl: "$REPO_URL"
featureBranch: "$FEATURE_BRANCH"
onFinish: none
tasks:
  - id: hello-world
    description: hello world
    command: echo hello world
    dependencies: []
YAML

[[ -x "$RUNNER" ]] || fail "Missing executable runner at $RUNNER"

cd "$ROOT_DIR"
log "Temp repro dir: $TMP_ROOT"
log "Starting headless owner with web surface enabled"

env "${COMMON_ENV[@]}" "$RUNNER" --headless owner-serve >"$OWNER_LOG" 2>&1 &
OWNER_PID="$!"

wait_for_owner_ready
BOUND_PORT="$(extract_web_port)"
[[ -n "$BOUND_PORT" ]] || fail "Could not extract web port from owner log"
log "Owner ready, web surface on port $BOUND_PORT"

log "Connecting SSE listener"
start_sse_listener "$BOUND_PORT"
sleep 1

log "Loading and running hello-world plan"
RUN_STDOUT="$LOG_DIR/run.stdout.log"
RUN_STDERR="$LOG_DIR/run.stderr.log"
if ! run_headless run "$PLAN_PATH" >"$RUN_STDOUT" 2>"$RUN_STDERR"; then
  tail -n 60 "$RUN_STDERR" >&2 || true
  fail "hello-world run failed"
fi

WORKFLOW_ID="$(parse_workflow_id_from_stdout "$RUN_STDOUT")"
[[ -n "$WORKFLOW_ID" ]] || fail "Could not parse workflow id"
log "Workflow id: $WORKFLOW_ID"

log "Waiting for workflow to complete"
deadline=$((SECONDS + TIMEOUT_SEC))
while (( SECONDS < deadline )); do
  status="$(run_headless query workflows --output json 2>/dev/null | python3 -c "
import json, sys
workflows = json.loads(sys.stdin.read().split('[', 1)[-1].rsplit(']', 1)[0] + ']' if '[' in sys.stdin.read() else '[]')
for wf in workflows:
    if wf.get('id') == '$WORKFLOW_ID':
        print(wf.get('status', 'unknown'))
        break
" 2>/dev/null || echo "unknown")"
  
  case "$status" in
    completed|review_ready)
      log "Workflow completed with status: $status"
      break
      ;;
    failed|blocked|closed)
      fail "Workflow finished with terminal status: $status"
      ;;
  esac
  sleep 1
done

sleep 2
kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true
SSE_PID=""

log "Comparing event timing"
if compare_event_timing "$WORKFLOW_ID"; then
  log "PASS: workflows-changed lag within threshold"
  printf 'comparison: %s\n' "$COMPARISON_JSON"
  exit 0
else
  log "FAIL: workflows-changed lag exceeds threshold (${LAG_THRESHOLD_MS}ms)"
  printf 'comparison: %s\n' "$COMPARISON_JSON"
  exit 1
fi
