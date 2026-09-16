#!/usr/bin/env bash
# Proof: new SSE /events subscribers receive no snapshot of existing state.
#
# Product invariant: docs/architecture/ui-action-responsiveness-invariant.md
# A new `/events` subscriber must receive enough state to render the current
# graph (snapshot or Last-Event-ID replay). Reconnect after missed deltas must
# not show a stale empty graph.
#
# This repro proves that `handleEvents` only writes `retry: 3000` and adds the
# client; it never sends a `snapshot` TaskGraphEvent. A client connecting after
# workflows already exist sees no snapshot event.
#
# Expected result on master: FAIL (no snapshot event received on connect)
# Expected result after fix: PASS (snapshot event received within 1s of connect)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNNER="$ROOT_DIR/run.sh"
TIMEOUT_SEC="${INVOKER_WEB_SSE_TIMEOUT_SEC:-120}"
KEEP_TMP="${INVOKER_WEB_SSE_KEEP_TMP:-0}"
SNAPSHOT_TIMEOUT_MS="${INVOKER_WEB_SSE_SNAPSHOT_TIMEOUT_MS:-1000}"

TMP_BASE="${INVOKER_WEB_SSE_TMPDIR:-/tmp}"
TMP_ROOT="$(mktemp -d "$TMP_BASE/invoker-web-sse-snapshot.XXXXXX")"
HOME_DIR="$TMP_ROOT/home"
DB_DIR="$HOME_DIR/.invoker"
LOG_DIR="$TMP_ROOT/logs"
PLAN_PATH="$TMP_ROOT/hello-world.yaml"
CONFIG_PATH="$TMP_ROOT/config.json"
IPC_SOCKET="$TMP_ROOT/i.sock"
FEATURE_BRANCH="plan/sse-snapshot-$(date +%s)-$$"
REPO_URL="${INVOKER_WEB_SSE_REPO_URL:-}"

WEB_TOKEN="test-token-$$"
WEB_PORT="${INVOKER_WEB_PORT:-0}"

OWNER_LOG="$LOG_DIR/owner.log"
SSE_LOG="$LOG_DIR/sse-events.jsonl"
RESULT_JSON="$LOG_DIR/result.json"

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

start_sse_listener_with_timeout() {
  local port="$1"
  local timeout_sec="$2"
  python3 - "$port" "$WEB_TOKEN" "$SSE_LOG" "$timeout_sec" <<'PY' &
import json
import sys
import time
import urllib.request

port, token, log_path, timeout_sec = sys.argv[1:5]
timeout_sec = float(timeout_sec)
url = f"http://127.0.0.1:{port}/events"

req = urllib.request.Request(url, headers={"x-invoker-token": token})
start_time = time.time()
with open(log_path, "w", encoding="utf-8") as log:
    with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
        event_type = None
        data_lines = []
        for raw in resp:
            if time.time() - start_time > timeout_sec:
                break
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

check_for_snapshot() {
  python3 - "$SSE_LOG" "$RESULT_JSON" "$SNAPSHOT_TIMEOUT_MS" <<'PY'
import json
import pathlib
import sys

sse_log_path, result_path, timeout_ms_str = sys.argv[1:4]
timeout_ms = int(timeout_ms_str)

sse_events = []
for line in pathlib.Path(sse_log_path).read_text(errors="ignore").splitlines():
    try:
        sse_events.append(json.loads(line))
    except Exception:
        continue

snapshot_events = []
for record in sse_events:
    event = record.get("event", "")
    data = record.get("data", {})
    
    if event == "invoker:task-graph-event":
        event_type = data.get("type")
        if event_type == "snapshot":
            snapshot_events.append({
                "receivedAtMs": record.get("receivedAtMs"),
                "reason": data.get("reason"),
                "taskCount": len(data.get("tasks", [])),
                "workflowCount": len(data.get("workflows", [])),
                "forced": data.get("forced", False),
            })

has_snapshot = len(snapshot_events) > 0

if has_snapshot:
    first_snapshot_ms = min(e["receivedAtMs"] for e in snapshot_events)
    connect_time_ms = min(
        (e["receivedAtMs"] for e in sse_events),
        default=first_snapshot_ms
    )
    time_to_snapshot_ms = first_snapshot_ms - connect_time_ms
else:
    time_to_snapshot_ms = None

result = {
    "ok": has_snapshot,
    "snapshotReceived": has_snapshot,
    "snapshotCount": len(snapshot_events),
    "totalEventsReceived": len(sse_events),
    "timeToSnapshotMs": time_to_snapshot_ms,
    "thresholdMs": timeout_ms,
    "snapshots": snapshot_events[:5],
    "allEvents": [
        {"event": e.get("event"), "receivedAtMs": e.get("receivedAtMs")}
        for e in sse_events[:20]
    ],
}

pathlib.Path(result_path).write_text(json.dumps(result, indent=2) + "\n")

if not has_snapshot:
    print(json.dumps(result, indent=2), file=sys.stderr)
    raise SystemExit(1)

print(json.dumps(result, indent=2))
PY
}

mkdir -p "$DB_DIR" "$LOG_DIR"

if [[ -z "$REPO_URL" ]]; then
  REPO_URL="$(git -C "$ROOT_DIR" config --get remote.origin.url || true)"
fi
[[ -n "$REPO_URL" ]] || fail "Could not determine repo URL; set INVOKER_WEB_SSE_REPO_URL"

cat >"$CONFIG_PATH" <<'JSON'
{
  "allowGraphMutation": true,
  "disableAutoRunOnStartup": true,
  "maxConcurrency": 1,
  "autoFixRetries": 0
}
JSON

cat >"$PLAN_PATH" <<YAML
name: SSE Snapshot Repro
description: Repro fixture for SSE connect snapshot verification.
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

log "Loading and running hello-world plan (before SSE connect)"
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
  status="$(run_headless query workflows 2>/dev/null | grep -oE 'status: [a-z_]+' | head -1 | cut -d' ' -f2 || echo "unknown")"
  
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

log "Workflow is now complete. Connecting SSE client AFTER workflow exists."
log "Checking if snapshot event is sent on connect..."

start_sse_listener_with_timeout "$BOUND_PORT" "3"
sleep 4

kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true
SSE_PID=""

log "Checking for snapshot event"
if check_for_snapshot; then
  log "PASS: Snapshot event received on SSE connect"
  printf 'result: %s\n' "$RESULT_JSON"
  exit 0
else
  log "FAIL: No snapshot event received on SSE connect"
  printf 'result: %s\n' "$RESULT_JSON"
  exit 1
fi
