#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=scripts/headless-lib.sh
source "$(dirname "$0")/headless-lib.sh"

DRY_RUN=false
TARGET_WORKFLOW=""
TIMEOUT_SECONDS="${BENCH_TIMEOUT_SECONDS:-900}"
POLL_INTERVAL_SECONDS="${BENCH_POLL_INTERVAL_SECONDS:-1}"
PARALLELISM="${BENCH_PARALLELISM:-1}"

usage() {
  cat <<'EOF'
Usage: scripts/bench-rebase-recreate-all.sh [--dry-run] [--workflow <id-or-name>] [--timeout <seconds>] [--parallel <count>]

Dispatches rebase-recreate across matching workflows, then reports
workflow_mutation_intents timing:
  intent id, workflow id/name, created, started, completed, queue wait seconds,
  run seconds, and final status.

Examples:
  scripts/bench-rebase-recreate-all.sh --dry-run
  scripts/bench-rebase-recreate-all.sh --workflow "Cost Query Attempt Attribution via Persisted Attempts"
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --workflow)
      TARGET_WORKFLOW="${2:-}"
      shift 2
      ;;
    --timeout)
      TIMEOUT_SECONDS="${2:-}"
      shift 2
      ;;
    --parallel)
      PARALLELISM="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "$TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --timeout value: $TIMEOUT_SECONDS" >&2
  exit 1
fi
if ! [[ "$PARALLELISM" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --parallel value: $PARALLELISM" >&2
  exit 1
fi

DB_PATH="${INVOKER_DB_PATH:-${INVOKER_DB_DIR:-$HOME/.invoker}/invoker.db}"
if [[ "$DRY_RUN" = false ]] && [[ ! -f "$DB_PATH" ]]; then
  echo "SQLite database not found: $DB_PATH" >&2
  exit 1
fi
if [[ "$DRY_RUN" = false ]] && ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required" >&2
  exit 1
fi

WORKFLOWS_JSON="$(headless_query query workflows --output json)"
WORKFLOWS_FILE="$(mktemp -t invoker-rebase-bench-workflows.XXXXXX)"
COMMANDS_FILE="$(mktemp -t invoker-rebase-bench-commands.XXXXXX)"
RESULT_FILE="$(mktemp -t invoker-rebase-bench-results.XXXXXX)"
LOG_DIR="$(mktemp -d -t invoker-rebase-bench-logs.XXXXXX)"
METRICS_FILE="$(mktemp -t invoker-rebase-bench-metrics.XXXXXX)"

cleanup() {
  rm -f "$WORKFLOWS_FILE" "$COMMANDS_FILE" "$RESULT_FILE" "$METRICS_FILE" >/dev/null 2>&1 || true
  if [[ "$DRY_RUN" = true ]]; then
    rm -rf "$LOG_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

WORKFLOWS_JSON_INPUT="$WORKFLOWS_JSON" node - "$TARGET_WORKFLOW" > "$WORKFLOWS_FILE" <<'NODE'
const target = process.argv[2] ?? '';
let workflows = [];
try {
  workflows = JSON.parse(process.env.WORKFLOWS_JSON_INPUT ?? '[]');
} catch {
  workflows = [];
}
for (const workflow of workflows) {
  const id = String(workflow.id ?? '');
  const name = String(workflow.name ?? id);
  if (target && id !== target && name !== target) continue;
  process.stdout.write(`${id}\t${name.replace(/\t/g, ' ')}\n`);
}
NODE

TOTAL_WORKFLOWS="$(wc -l < "$WORKFLOWS_FILE" | tr -d ' ')"
if [[ "$TOTAL_WORKFLOWS" -eq 0 ]]; then
  if [[ -n "$TARGET_WORKFLOW" ]]; then
    echo "No workflow matched: $TARGET_WORKFLOW" >&2
  else
    echo "No workflows found." >&2
  fi
  exit 0
fi

echo "Benchmark target workflows: $TOTAL_WORKFLOWS" >&2
if [[ -n "$TARGET_WORKFLOW" ]]; then
  echo "Focused workflow: $TARGET_WORKFLOW" >&2
fi

LAST_INTENT_ID=0
if [[ "$DRY_RUN" = false ]]; then
  LAST_INTENT_ID="$(sqlite3 -noheader "$DB_PATH" "select coalesce(max(id), 0) from workflow_mutation_intents;" 2>/dev/null || echo 0)"
fi

while IFS=$'\t' read -r workflow_id workflow_name; do
  [[ -z "$workflow_id" ]] && continue
  if [[ "$DRY_RUN" = true ]]; then
    printf '[DRY RUN] would dispatch rebase-recreate\t%s\t%s\n' "$workflow_id" "$workflow_name"
  else
    printf '{"label":"%s","workflowId":"%s","args":["rebase-recreate","%s"]}\n' \
      "$workflow_id" "$workflow_id" "$workflow_id" >> "$COMMANDS_FILE"
  fi
done < "$WORKFLOWS_FILE"

if [[ "$DRY_RUN" = true ]]; then
  exit 0
fi

batch_dispatch "$COMMANDS_FILE" "$RESULT_FILE" "$LOG_DIR" "$PARALLELISM"
read -r DISPATCHED LAUNCH_FAILED _ < <(count_results "$RESULT_FILE")
echo "Dispatch accepted: $DISPATCHED; launch failed: $LAUNCH_FAILED; logs: $LOG_DIR" >&2
if [[ "$DISPATCHED" -ne "$TOTAL_WORKFLOWS" ]]; then
  echo "Dispatch incomplete: accepted $DISPATCHED of $TOTAL_WORKFLOWS workflows." >&2
  exit 1
fi
if [[ "$LAUNCH_FAILED" -ne 0 ]]; then
  exit 1
fi

WORKFLOW_ID_LIST="$(
  awk -F '\t' '{ printf "%s'\''%s'\''", sep, $1; sep="," }' "$WORKFLOWS_FILE"
)"

started_at_epoch="$(date +%s)"
while true; do
  pending_count="$(
    sqlite3 -noheader "$DB_PATH" "
      select count(*)
      from workflow_mutation_intents
      where id > $LAST_INTENT_ID
        and workflow_id in ($WORKFLOW_ID_LIST)
        and args_json like '%rebase-recreate%'
        and status in ('queued', 'running');
    "
  )"
  intent_count="$(
    sqlite3 -noheader "$DB_PATH" "
      select count(*)
      from workflow_mutation_intents
      where id > $LAST_INTENT_ID
        and workflow_id in ($WORKFLOW_ID_LIST)
        and args_json like '%rebase-recreate%';
    "
  )"
  if [[ "$intent_count" -ge "$TOTAL_WORKFLOWS" && "$pending_count" -eq 0 ]]; then
    break
  fi
  if (( $(date +%s) - started_at_epoch >= TIMEOUT_SECONDS )); then
    echo "Timed out waiting for rebase-recreate intents (seen=$intent_count pending=$pending_count)." >&2
    break
  fi
  sleep "$POLL_INTERVAL_SECONDS"
done

sqlite3 -header -separator $'\t' "$DB_PATH" "
  with target_workflows(id, name) as (
    values $(awk -F '\t' '{ gsub(/\047/, "\047\047", $1); gsub(/\047/, "\047\047", $2); printf "%s('\''%s'\'','\''%s'\'')", sep, $1, $2; sep="," }' "$WORKFLOWS_FILE")
  )
  select
    i.id as intent_id,
    i.workflow_id,
    target_workflows.name as workflow_name,
    i.created_at,
    coalesce(i.started_at, '') as started_at,
    coalesce(i.completed_at, '') as completed_at,
    case
      when i.started_at is null then ''
      else printf('%.3f', (julianday(i.started_at) - julianday(i.created_at)) * 86400.0)
    end as queue_wait_seconds,
    case
      when i.started_at is null or i.completed_at is null then ''
      else printf('%.3f', (julianday(i.completed_at) - julianday(i.started_at)) * 86400.0)
    end as run_seconds,
    i.status as final_status
  from workflow_mutation_intents i
  join target_workflows on target_workflows.id = i.workflow_id
  where i.id > $LAST_INTENT_ID
    and i.args_json like '%rebase-recreate%'
  order by i.id asc;
" | tee "$METRICS_FILE"

python3 - "$METRICS_FILE" "$TARGET_WORKFLOW" <<'PY'
import csv
import statistics
import sys

path, target = sys.argv[1], sys.argv[2]
rows = list(csv.DictReader(open(path, encoding="utf-8"), delimiter="\t"))
waits = [float(row["queue_wait_seconds"]) for row in rows if row.get("queue_wait_seconds")]
runs = [float(row["run_seconds"]) for row in rows if row.get("run_seconds")]
statuses = {}
for row in rows:
    statuses[row["final_status"]] = statuses.get(row["final_status"], 0) + 1

print("")
print("Summary:")
print(f"  intents: {len(rows)}")
print(f"  statuses: {', '.join(f'{k}={v}' for k, v in sorted(statuses.items())) or 'none'}")
if waits:
    print(f"  queue_wait_seconds median={statistics.median(waits):.3f} max={max(waits):.3f}")
if runs:
    print(f"  run_seconds median={statistics.median(runs):.3f} max={max(runs):.3f}")
if target:
    matches = [
        row for row in rows
        if row["workflow_id"] == target or row["workflow_name"] == target
    ]
    if matches:
        row = matches[-1]
        print(
            "  target_queue_wait_seconds="
            f"{row['queue_wait_seconds'] or 'pending'} "
            f"workflow={row['workflow_id']} status={row['final_status']}"
        )
PY
