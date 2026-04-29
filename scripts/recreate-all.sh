#!/usr/bin/env bash
# Recreate (nuclear restart) all workflows.
#
# Uses the headless CLI to query workflows, then runs recreate on each.
#
# Usage:
#   bash scripts/recreate-all.sh                       # all workflows
#   bash scripts/recreate-all.sh --status running      # only running workflows
#   bash scripts/recreate-all.sh --status failed       # only failed workflows
#   bash scripts/recreate-all.sh --dry-run             # show what would run
#   bash scripts/recreate-all.sh --parallel 8          # run up to 8 recreates at once
#   bash scripts/recreate-all.sh --follow              # wait for completion (default is fire-and-forget)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$REPO_ROOT/run.sh"
ELECTRON="$REPO_ROOT/packages/app/node_modules/.bin/electron"
MAIN="$REPO_ROOT/packages/app/dist/main.js"
IPC_HELPER="$REPO_ROOT/scripts/headless-ipc.js"
STANDALONE_MODE="${INVOKER_HEADLESS_STANDALONE:-0}"

# Parse args
DRY_RUN=false
STATUS_FILTER=""
PARALLELISM=""
FOLLOW=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --follow) FOLLOW=true; shift ;;
    --status) STATUS_FILTER="$2"; shift 2 ;;
    --parallel) PARALLELISM="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -n "$PARALLELISM" ]] && ! [[ "$PARALLELISM" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid --parallel value: $PARALLELISM (expected integer >= 1)" >&2
  exit 1
fi

# Electron sandbox detection
unset ELECTRON_RUN_AS_NODE
SANDBOX_FLAG=""
if [ "$(uname)" = "Linux" ]; then
  SANDBOX_BIN="$REPO_ROOT/node_modules/.pnpm/electron@*/node_modules/electron/dist/chrome-sandbox"
  # shellcheck disable=SC2086
  if ! stat -c '%U:%a' $SANDBOX_BIN 2>/dev/null | grep -q '^root:4755$'; then
    SANDBOX_FLAG="--no-sandbox"
  fi
  export LIBGL_ALWAYS_SOFTWARE=1
fi

# Helper: read-only query command (stderr hidden to keep parsing clean)
headless_query() {
  # shellcheck disable=SC2086
  "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@" 2>/dev/null
}

# Helper: mutating command delegated to the current owner (GUI or standalone headless)
headless_mutation() {
  if [[ "$STANDALONE_MODE" = "1" ]]; then
    "$RUNNER" --headless "$@"
    return $?
  fi
  node "$IPC_HELPER" exec -- "$@"
}

# Helper: extract workflow IDs from label output.
headless_workflow_ids() {
  headless_query "$@" | grep -E '^wf-[0-9]+-[0-9]+$' || true
}

# Query workflow IDs via CLI
QUERY_ARGS=(query workflows --output label)
if [[ -n "$STATUS_FILTER" ]]; then
  QUERY_ARGS+=(--status "$STATUS_FILTER")
fi

WORKFLOWS=$(headless_workflow_ids "${QUERY_ARGS[@]}")

if [[ -z "$WORKFLOWS" ]]; then
  echo "No workflows found."
  exit 0
fi

# Count workflows
TOTAL=$(echo "$WORKFLOWS" | wc -l | tr -d ' ')
if [[ -z "$PARALLELISM" ]]; then
  PARALLELISM="$TOTAL"
fi
echo "Found $TOTAL workflow(s) to recreate."
echo "Parallelism: $PARALLELISM"
echo "Follow mode: $FOLLOW"
if ! $FOLLOW; then
  echo "Note: fire-and-forget dispatches all workflows immediately; --parallel is enforced with --follow."
fi
echo ""

IDX=0
FAILED=0
SUCCEEDED=0

if $DRY_RUN; then
  while IFS= read -r WF_ID; do
    [[ -z "$WF_ID" ]] && continue
    IDX=$((IDX + 1))
    echo "[$IDX/$TOTAL] $WF_ID"
    echo "         (dry-run) would run: recreate $WF_ID"
    echo ""
  done <<< "$WORKFLOWS"
elif $FOLLOW; then
  RESULTS_FILE="$(mktemp -t recreate-all-results.XXXXXX)"
  PIDS=()

  process_one_workflow() {
    local wf_id="$1"
    local result_file="$2"
    local cmd_out=""
    local cmd_status=0

    set +e
    cmd_out="$(headless_mutation recreate "$wf_id" 2>&1)"
    cmd_status=$?
    set -e

    if [[ "$cmd_status" -eq 0 ]]; then
      echo "[$wf_id] OK"
      printf "%s\n" "$cmd_out"
      printf "%s\tSUCCEEDED\n" "$wf_id" >> "$result_file"
    else
      echo "[$wf_id] FAILED (exit $cmd_status)"
      printf "%s\n" "$cmd_out"
      printf "%s\tFAILED\n" "$wf_id" >> "$result_file"
    fi
    echo ""
  }

  while IFS= read -r WF_ID; do
    [[ -z "$WF_ID" ]] && continue
    IDX=$((IDX + 1))
    echo "[queue $IDX/$TOTAL] $WF_ID"

    process_one_workflow "$WF_ID" "$RESULTS_FILE" &
    PIDS+=("$!")

    while [[ "$(jobs -pr | wc -l | tr -d ' ')" -ge "$PARALLELISM" ]]; do
      sleep 0.2
    done
  done <<< "$WORKFLOWS"

  for pid in "${PIDS[@]}"; do
    wait "$pid" || true
  done

  while IFS=$'\t' read -r _wf result; do
    case "$result" in
      SUCCEEDED) SUCCEEDED=$((SUCCEEDED + 1)) ;;
      FAILED) FAILED=$((FAILED + 1)) ;;
    esac
  done < "$RESULTS_FILE"

  rm -f "$RESULTS_FILE"
else
  LOG_DIR="$(mktemp -d -t recreate-all-logs.XXXXXX)"
  DISPATCHED=0
  LAUNCH_FAILED=0
  RESULT_FILE="$(mktemp -t recreate-all-results.XXXXXX)"
  COMMANDS_FILE="$(mktemp -t recreate-all-commands.XXXXXX)"
  OUTPUT_JSONL="$(mktemp -t recreate-all-output.XXXXXX)"

  while IFS= read -r WF_ID; do
    [[ -z "$WF_ID" ]] && continue
    IDX=$((IDX + 1))
    printf '{"label":"%s","workflowId":"%s","args":["recreate","%s"]}\n' "$WF_ID" "$WF_ID" "$WF_ID" >> "$COMMANDS_FILE"
    echo "[dispatch $IDX/$TOTAL] $WF_ID log=$LOG_DIR/${WF_ID}.log"
  done <<< "$WORKFLOWS"

  if [[ "$STANDALONE_MODE" = "1" ]]; then
    while IFS= read -r WF_ID; do
      [[ -z "$WF_ID" ]] && continue
      if headless_mutation --no-track recreate "$WF_ID" > "$LOG_DIR/${WF_ID}.log" 2>&1; then
        printf "%s\tSUCCEEDED\n" "$WF_ID" >> "$RESULT_FILE"
      else
        printf "%s\tFAILED\n" "$WF_ID" >> "$RESULT_FILE"
      fi
    done <<< "$WORKFLOWS"
  else
    node "$IPC_HELPER" batch-exec --no-track --parallel "$PARALLELISM" < "$COMMANDS_FILE" > "$OUTPUT_JSONL"
    python3 - "$RESULT_FILE" "$LOG_DIR" "$OUTPUT_JSONL" <<'PY'
import json
import pathlib
import sys

result_file = pathlib.Path(sys.argv[1])
log_dir = pathlib.Path(sys.argv[2])
output_jsonl = pathlib.Path(sys.argv[3])

for raw in output_jsonl.read_text(encoding="utf-8").splitlines():
    raw = raw.strip()
    if not raw:
        continue
    item = json.loads(raw)
    workflow_id = item.get("workflowId") or item.get("label") or "unknown"
    (log_dir / f"{workflow_id}.log").write_text(raw + "\n", encoding="utf-8")
    with result_file.open("a", encoding="utf-8") as handle:
        handle.write(f"{workflow_id}\t{'SUCCEEDED' if item.get('ok') else 'FAILED'}\n")
PY
  fi
  rm -f "$COMMANDS_FILE"
  rm -f "$OUTPUT_JSONL"

  while IFS=$'\t' read -r _wf result; do
    case "$result" in
      SUCCEEDED) DISPATCHED=$((DISPATCHED + 1)) ;;
      FAILED) LAUNCH_FAILED=$((LAUNCH_FAILED + 1)) ;;
    esac
  done < "$RESULT_FILE"
  rm -f "$RESULT_FILE"
fi

echo "---"
if $DRY_RUN; then
  echo "Dry run complete. $TOTAL workflow(s) would be recreated."
elif $FOLLOW; then
  echo "Done. $SUCCEEDED succeeded, $FAILED failed out of $TOTAL."
  if [[ "$FAILED" -ne 0 ]]; then
    exit 1
  fi
else
  echo "Dispatched $DISPATCHED workflow(s) (fire-and-forget). Logs: $LOG_DIR"
  if [[ "$LAUNCH_FAILED" -ne 0 ]]; then
    echo "$LAUNCH_FAILED workflow(s) failed to launch."
    exit 1
  fi
fi
