#!/usr/bin/env bash
# Render a launch timeline for one task from persisted audit events.
#
# Usage:
#   bash scripts/trace-task-launch-timeline.sh <taskId>
#   bash scripts/trace-task-launch-timeline.sh --attempt <attemptId> <taskId>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$REPO_ROOT/run.sh"

ATTEMPT_ID=""
TASK_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --attempt)
      ATTEMPT_ID="${2:-}"
      if [[ -z "$ATTEMPT_ID" ]]; then
        echo "Missing value for --attempt" >&2
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      if [[ -n "$TASK_ID" ]]; then
        echo "Unexpected argument: $1" >&2
        exit 1
      fi
      TASK_ID="$1"
      shift
      ;;
  esac
done

if [[ -z "$TASK_ID" ]]; then
  echo "Usage: $0 [--attempt <attemptId>] <taskId>" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

EVENTS_FILE="$(mktemp -t invoker-task-launch-events.XXXXXX)"
trap 'rm -f "$EVENTS_FILE"' EXIT

"$RUNNER" --headless query audit "$TASK_ID" --output jsonl 2>/dev/null | awk '/^\{/{print}' > "$EVENTS_FILE"
if [[ ! -s "$EVENTS_FILE" ]]; then
  echo "No audit events found for task: $TASK_ID" >&2
  exit 1
fi

jq -R -s -r --arg task_id "$TASK_ID" --arg requested_attempt "$ATTEMPT_ID" '
  def payload:
    (.payload // "{}") as $raw
    | if ($raw | type) == "object" then $raw
      else (try ($raw | fromjson) catch {})
      end;

  def time_string:
    payload as $p
    | (
        $p.execution.launchStartedAt
        // $p.execution.completedAt
        // $p.execution.startedAt
        // .createdAt
      );

  def epoch:
    time_string as $raw
    | if $raw == null then null
      else
        ($raw | tostring) as $s
        | if ($s | test("T")) then
            ($s | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)
          else
            ($s | gsub(" "; "T") + "Z" | fromdateiso8601)
          end
      end;

  def attempt:
    payload as $p
    | ($p.attemptId // $p.execution.selectedAttemptId // null);

  def phase:
    payload as $p
    | ($p.phase // $p.execution.phase // "");

  def short_error:
    payload as $p
    | ($p.execution.error // $p.error // "")
    | tostring
    | split("\n")[0];

  def event_label:
    payload as $p
    | if .eventType == "task.launch_claimed" then
        "Orchestrator launch claim"
      elif .eventType == "task.launch_dispatch" and ($p.phase // "") == "executeTasks.before" then
        "dispatchStartedTasksWithGlobalTopup()"
      elif .eventType == "task.launch_dispatch" and ($p.phase // "") == "fireAndForget.accepted" then
        "fire-and-forget dispatch accepted"
      elif .eventType == "task.launch_dispatch" and ($p.phase // "") == "executeTasks.resolved" then
        "dispatchStartedTasksWithGlobalTopup() resolved"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "executeTasks.received" then
        "TaskRunner.executeTasks()"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "executeTask.enter" then
        "TaskRunner.executeTask()"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "executeTask.launchingAttemptRegistered" then
        "executeTask.launchingAttemptRegistered"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "executeTaskInner.enter" then
        "TaskRunner.executeTaskInner()"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "workRequest.built" then
        "buildUpstreamContext() / WorkRequest built"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "selectExecutor.before" then
        "TaskRunner.selectExecutor() before"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "selectExecutor.after" then
        "TaskRunner.selectExecutor() after"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "onLaunchStart.before" then
        "callbacks.onLaunchStart() before"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "onLaunchStart.after" then
        "callbacks.onLaunchStart() after"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "executor.start.before" then
        (($p.executorType // "Executor") + ".start() before")
      elif .eventType == "task.execute_task" and ($p.phase // "") == "executor.start.after" then
        (($p.executorType // "Executor") + ".start() after")
      elif .eventType == "task.execute_task" and ($p.phase // "") == "executeTask.innerReturned" then
        "TaskRunner.executeTaskInner() returned"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "executeTask.settled" then
        "TaskRunner.executeTask() settled"
      elif .eventType == "task.execute_task" and ($p.phase // "") == "executeTasks.resolved" then
        "TaskRunner.executeTasks() resolved"
      elif .eventType == "task.executor_startup_timing" then
        ($p.phase // "executor startup")
      elif .eventType == "task.failed" then
        "task.failed"
      elif .eventType == "task.fixing_with_ai" then
        "auto-fix starts"
      else
        .eventType + (if ($p.phase // "") != "" then " / " + ($p.phase | tostring) else "" end)
      end;

  def notes:
    payload as $p
    | [
        (if ($p.executorType // null) then "executor=" + ($p.executorType | tostring) else empty end),
        (if ($p.elapsedMs // null) then "elapsedMs=" + ($p.elapsedMs | tostring) else empty end),
        (if ($p.deltaMs // null) then "deltaMs=" + ($p.deltaMs | tostring) else empty end),
        (if ($p.executorStartMs // null) then "executorStartMs=" + ($p.executorStartMs | tostring) else empty end),
        (if ($p.startTimeoutMs // null) then "startTimeoutMs=" + ($p.startTimeoutMs | tostring) else empty end),
        (if ($p.runnerKind // null) then "runnerKind=" + ($p.runnerKind | tostring) else empty end),
        (if ($p.poolId // null) then "poolId=" + ($p.poolId | tostring) else empty end),
        (if (short_error | length) > 0 then "error=" + short_error else empty end)
      ] | join("; ");

  def fmt_delta($seconds):
    if $seconds == null then "-"
    elif $seconds < 1 then "+0s"
    elif $seconds < 10 then "+" + (($seconds * 1000 | round) / 1000 | tostring) + "s"
    else "+" + (($seconds * 10 | round) / 10 | tostring) + "s"
    end;

  def fmt_time:
    (time_string | tostring)
    | if test("T") then sub("^.*T"; "") | sub("Z$"; "")
      else split(" ")[1]
      end;

  def gap_note($prev; $row):
    if ($prev.payloadObj.phase // "") == "executor.start.before" and $row.eventType == "task.failed" then
      "Watchdog fired while executor.start() was still pending. New attempts should include task.executor_startup_timing rows inside this gap."
    elif ($prev.payloadObj.phase // "") == "executor.start.before" and ($row.payloadObj.phase // "") == "executor.start.after" then
      "Complete executor.start() duration. For WorktreeExecutor this includes repo clone/fetch/base resolution, worktree acquire/reset, provisioning, command build, and process spawn."
    elif ($row.payloadObj.phase // "") == "executor.start.after" and ($row.payloadObj.executorStartMs // null) != null then
      "Executor reported startup duration as executorStartMs=" + ($row.payloadObj.executorStartMs | tostring) + "ms."
    else
      "No finer-grained persisted audit event in this gap."
    end;

  (split("\n") | map(select(length > 0) | try fromjson catch empty)) as $input_events
  | [ $input_events[] | . + { payloadObj: payload, epoch: epoch, attempt: attempt } ] as $events
  | (
      if $requested_attempt != "" then $requested_attempt
      else
        (
          ($events | map(select(.eventType == "task.failed" and .epoch != null)) | sort_by(.epoch) | last) as $latest_failed
          | if ($latest_failed // null) != null then
              (
                $events
                | map(select(.eventType == "task.launch_claimed" and .attempt != null and .epoch <= $latest_failed.epoch))
                | sort_by(.epoch)
                | last
                | .attempt
              )
            else
              (
                $events
                | map(select(.eventType == "task.launch_claimed" and .attempt != null))
                | sort_by(.epoch)
                | last
                | .attempt
              )
            end
        )
      end
    ) as $attempt
  | if ($attempt // "") == "" then
      "No launch attempt found for task: " + $task_id
    else
      ($events | map(select(.eventType == "task.launch_claimed" and .attempt == $attempt)) | sort_by(.epoch) | last) as $start
      | (
          $events
          | map(select(.eventType == "task.launch_claimed" and .attempt != $attempt and .epoch > $start.epoch))
          | sort_by(.epoch)
          | first
          | .epoch // ($start.epoch + 180)
        ) as $end_epoch
      | (
          $events
          | map(select(.epoch != null))
          | map(select(
              .epoch >= $start.epoch
              and .epoch < $end_epoch
              and (
                (.attempt == null or .attempt == $attempt)
                or (.eventType == "task.failed" or .eventType == "task.fixing_with_ai" or .eventType == "debug.auto-fix")
              )
            ))
          | sort_by(.epoch, .id)
        ) as $rows
      | if ($rows | length) == 0 then
          "No timeline rows found for task `" + $task_id + "` attempt `" + $attempt + "`"
        else
          "Task: `" + $task_id + "`\n"
          + "Attempt: `" + $attempt + "`\n\n"
          + "| Time | Delta From Previous | Delta From Launch | Function / Event | Notes |\n"
          + "|---|---:|---:|---|---|\n"
          + (
              $rows
              | reduce range(0; length) as $i ("";
                  . + (
                    . as $out
                    | $rows[$i] as $row
                    | ($rows[$i - 1] // null) as $prev
                    | "| `" + ($row | fmt_time) + "`"
                      + " | `" + (fmt_delta(if $prev == null then null else ($row.epoch - $prev.epoch) end)) + "`"
                      + " | `" + (fmt_delta($row.epoch - $start.epoch)) + "`"
                      + " | " + ($row | event_label)
                      + " | " + ($row | notes)
                      + " |\n"
                  )
                )
            )
          + "\n**Longest Gaps**\n\n"
          + "| From -> To | Duration | What it means |\n"
          + "|---|---:|---|\n"
          + (
              [
                range(1; ($rows | length)) as $i
                | ($rows[$i - 1]) as $prev
                | ($rows[$i]) as $row
                | {
                    prev: $prev,
                    row: $row,
                    delta: ($row.epoch - $prev.epoch)
                  }
                | select(.delta >= 1)
              ]
              | sort_by(-.delta)
              | .[:5]
              | if length == 0 then
                  "| - | - | No gaps of at least 1s. |\n"
                else
                  reduce .[] as $gap ("";
                    . + "| "
                      + ($gap.prev | event_label)
                      + " -> "
                      + ($gap.row | event_label)
                      + " | `"
                      + (fmt_delta($gap.delta))
                      + "` | "
                      + (gap_note($gap.prev; $gap.row))
                      + " |\n"
                  )
                end
            )
        end
    end
' "$EVENTS_FILE"
