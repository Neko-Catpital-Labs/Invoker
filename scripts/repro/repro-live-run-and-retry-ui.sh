#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER="$REPO_ROOT/run.sh"
RETRY_SCRIPT="$REPO_ROOT/scripts/retry-failed-and-pending-all-workflows.sh"

WINDOW_TIMEOUT_SEC="${INVOKER_LIVE_WINDOW_TIMEOUT_SEC:-240}"
UI_MAX_LAG_MS="${INVOKER_UI_MAX_LAG_MS:-1000}"
UI_MAX_LONG_TASK_MS="${INVOKER_UI_MAX_LONG_TASK_MS:-1500}"
CPU_HOT_THRESHOLD="${INVOKER_UI_CPU_HOT_THRESHOLD:-95}"
CPU_HOT_CONSECUTIVE_LIMIT="${INVOKER_UI_CPU_HOT_CONSECUTIVE_LIMIT:-5}"
GRAPH_DRAG_DELTA_PX="${INVOKER_GRAPH_DRAG_DELTA_PX:-180}"

if [[ ! -x "$RUNNER" ]]; then
  echo "Missing executable runner at $RUNNER" >&2
  exit 1
fi

if [[ ! -x "$RETRY_SCRIPT" ]]; then
  echo "Missing executable retry script at $RETRY_SCRIPT" >&2
  exit 1
fi

LAUNCH_LOG="$(mktemp -t invoker-live-launch.XXXXXX.log)"
RETRY_LOG="$(mktemp -t invoker-live-retry.XXXXXX.log)"
STARTED_RUNNER_PID=""
KEEP_ON_FAIL="${INVOKER_LIVE_KEEP_ON_FAIL:-0}"

cleanup() {
  if [[ "$KEEP_ON_FAIL" = "1" ]]; then
    return
  fi
  if [[ -n "$STARTED_RUNNER_PID" ]] && kill -0 "$STARTED_RUNNER_PID" 2>/dev/null; then
    kill "$STARTED_RUNNER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

query_ui_perf() {
  "$RUNNER" --headless query ui-perf --output json "$@"
}

window_id() {
  xwininfo -root -tree 2>/dev/null | awk '/\("invoker" "invoker"\)/ {print $1; exit}'
}

wait_for_window() {
  local deadline=$((SECONDS + WINDOW_TIMEOUT_SEC))
  while (( SECONDS < deadline )); do
    if [[ -n "$(window_id)" ]]; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_live_ui_perf() {
  local deadline=$((SECONDS + WINDOW_TIMEOUT_SEC))
  while (( SECONDS < deadline )); do
    if query_ui_perf >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

read_json_field() {
  local json="$1"
  local field="$2"
  JSON_PAYLOAD="$json" python3 - "$field" <<'PY'
import json, os, sys
field = sys.argv[1]
data = json.loads(os.environ["JSON_PAYLOAD"])
value = data.get(field, 0)
if isinstance(value, bool):
    print('true' if value else 'false')
else:
    print(value)
PY
}

sample_cpu() {
  local pid="$1"
  ps -p "$pid" -o %cpu= | awk '{ print int($1 + 0) }'
}

drag_graph_probe() {
  local win_id="$1"
  local direction="${2:-1}"
  local before after
  local X Y W H START_X START_Y END_X

  before="$(xwd -silent -id "$win_id" | sha256sum | awk '{ print $1 }')"
  eval "$(xwininfo -id "$win_id" | awk -F: '
    /Absolute upper-left X/ { gsub(/ /, "", $2); print "X=" $2 }
    /Absolute upper-left Y/ { gsub(/ /, "", $2); print "Y=" $2 }
    /^  Width/ { gsub(/ /, "", $2); print "W=" $2 }
    /^  Height/ { gsub(/ /, "", $2); print "H=" $2 }
  ')"
  START_X=$((X + W / 3))
  START_Y=$((Y + H / 2))
  END_X=$((START_X + (direction * GRAPH_DRAG_DELTA_PX)))
  xdotool windowactivate --sync "$win_id" \
    mousemove "$START_X" "$START_Y" \
    mousedown 1 \
    mousemove --sync "$END_X" "$START_Y" \
    mouseup 1 >/dev/null 2>&1
  sleep 1
  after="$(xwd -silent -id "$win_id" | sha256sum | awk '{ print $1 }')"
  [[ "$before" != "$after" ]]
}

echo "Starting live GUI via ./run.sh ..."
pkill -f "electron.*packages/app/dist/main.js" 2>/dev/null || true
pkill -f "packages/app/dist/main.js --headless owner-serve" 2>/dev/null || true
pkill -f "packages/app/node_modules/.bin/../electron/cli.js packages/app/dist/main.js" 2>/dev/null || true
sleep 0.5
if command -v setsid >/dev/null 2>&1; then
  setsid "$RUNNER" >"$LAUNCH_LOG" 2>&1 </dev/null &
else
  nohup "$RUNNER" >"$LAUNCH_LOG" 2>&1 </dev/null &
fi
STARTED_RUNNER_PID="$!"

echo "Waiting for Invoker window ..."
wait_for_window || {
  echo "Timed out waiting for Invoker window. Launch log: $LAUNCH_LOG" >&2
  tail -n 100 "$LAUNCH_LOG" >&2 || true
  exit 1
}
wait_for_live_ui_perf || {
  echo "Timed out waiting for live UI perf query from owner. Launch log: $LAUNCH_LOG" >&2
  tail -n 100 "$LAUNCH_LOG" >&2 || true
  exit 1
}

initial_perf="$(query_ui_perf)"
owner_mode="$(read_json_field "$initial_perf" ownerMode)"
if [[ "$owner_mode" != "gui" ]]; then
  echo "Live UI perf query did not attach to the GUI owner (ownerMode=$owner_mode)." >&2
  echo "Initial perf payload: $initial_perf" >&2
  exit 1
fi

GUI_PID="$(pgrep -af '[e]lectron/dist/electron .*packages/app/dist/main.js --no-sandbox' | awk 'NR==1 {print $1}')"
if [[ -z "$GUI_PID" ]]; then
  GUI_PID="$(pgrep -af '[e]lectron/dist/electron .*packages/app/dist/main.js' | awk 'NR==1 {print $1}')"
fi
if [[ -z "$GUI_PID" ]]; then
  echo "Could not locate live Electron PID after window launch." >&2
  exit 1
fi

echo "Window detected. GUI PID: $GUI_PID"
WIN_ID="$(window_id)"
if [[ -z "$WIN_ID" ]]; then
  echo "Could not resolve the live Invoker X11 window id." >&2
  exit 1
fi
echo "Running startup graph drag probe on window $WIN_ID ..."
if ! drag_graph_probe "$WIN_ID" 1; then
  echo "Startup graph drag probe failed: graph did not visibly move after render." >&2
  exit 1
fi
echo "Resetting UI perf counters ..."
query_ui_perf --reset >/dev/null

echo "Running retry script: $RETRY_SCRIPT $*"
"$RETRY_SCRIPT" "$@" >"$RETRY_LOG" 2>&1 &
RETRY_PID="$!"

max_lag=0
max_long=0
hot_cpu_streak=0
drag_direction=1

while kill -0 "$RETRY_PID" 2>/dev/null; do
  if ! perf_json="$(query_ui_perf 2>/dev/null)"; then
    cpu="$(sample_cpu "$GUI_PID")"
    if (( cpu >= CPU_HOT_THRESHOLD )); then
      hot_cpu_streak=$((hot_cpu_streak + 1))
    else
      hot_cpu_streak=0
    fi
    if drag_graph_probe "$WIN_ID" "$drag_direction"; then
      echo "sample ui-perf=query-timeout drag=ok cpu=${cpu}%"
      drag_direction=$((drag_direction * -1))
      if (( hot_cpu_streak >= CPU_HOT_CONSECUTIVE_LIMIT )); then
        echo "Live GUI stayed hot at >= ${CPU_HOT_THRESHOLD}% CPU for ${hot_cpu_streak} consecutive samples." >&2
        break
      fi
      sleep 1
      continue
    fi
    echo "Live UI probe failed: ui-perf timed out and graph drag produced no visible change." >&2
    exit 1
  fi
  lag="$(read_json_field "$perf_json" maxRendererEventLoopLagMs)"
  long_task="$(read_json_field "$perf_json" maxRendererLongTaskMs)"
  cpu="$(sample_cpu "$GUI_PID")"

  if (( lag > max_lag )); then max_lag="$lag"; fi
  if (( long_task > max_long )); then max_long="$long_task"; fi

  if (( cpu >= CPU_HOT_THRESHOLD )); then
    hot_cpu_streak=$((hot_cpu_streak + 1))
  else
    hot_cpu_streak=0
  fi

  printf 'sample lag=%sms longTask=%sms cpu=%s%%\n' "$lag" "$long_task" "$cpu"

  if ! drag_graph_probe "$WIN_ID" "$drag_direction"; then
    echo "Live graph drag probe failed during retry burst." >&2
    exit 1
  fi
  drag_direction=$((drag_direction * -1))

  if (( hot_cpu_streak >= CPU_HOT_CONSECUTIVE_LIMIT )); then
    echo "Live GUI stayed hot at >= ${CPU_HOT_THRESHOLD}% CPU for ${hot_cpu_streak} consecutive samples." >&2
    break
  fi
  sleep 1
done

wait "$RETRY_PID" || true
final_perf="$(query_ui_perf)"
final_lag="$(read_json_field "$final_perf" maxRendererEventLoopLagMs)"
final_long="$(read_json_field "$final_perf" maxRendererLongTaskMs)"
if (( final_lag > max_lag )); then max_lag="$final_lag"; fi
if (( final_long > max_long )); then max_long="$final_long"; fi

echo "Launch log: $LAUNCH_LOG"
echo "Retry log: $RETRY_LOG"
echo "Final UI perf: $final_perf"

if (( max_lag >= UI_MAX_LAG_MS )); then
  echo "UI lag threshold exceeded: ${max_lag}ms >= ${UI_MAX_LAG_MS}ms" >&2
  exit 1
fi
if (( max_long >= UI_MAX_LONG_TASK_MS )); then
  echo "UI long-task threshold exceeded: ${max_long}ms >= ${UI_MAX_LONG_TASK_MS}ms" >&2
  exit 1
fi
if (( hot_cpu_streak >= CPU_HOT_CONSECUTIVE_LIMIT )); then
  echo "UI CPU hot streak threshold exceeded." >&2
  exit 1
fi

echo "Live run/retry validation passed."
