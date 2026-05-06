#!/usr/bin/env bash
# Shared helpers for bulk headless scripts.
#
# Source this file at the top of any bulk headless script:
#   source "$(dirname "$0")/headless-lib.sh"
#
# Provides:
#   Variables  — REPO_ROOT, RUNNER, ELECTRON, MAIN, IPC_HELPER,
#                STANDALONE_MODE, SANDBOX_FLAG
#   Functions  — headless_query, headless_mutation, headless_workflow_ids,
#                headless_task_ids, run_with_optional_timeout,
#                batch_dispatch, parse_batch_results, count_results
#
# The caller must set -euo pipefail before sourcing.

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER="$REPO_ROOT/run.sh"
ELECTRON="$REPO_ROOT/packages/app/node_modules/.bin/electron"
MAIN="$REPO_ROOT/packages/app/dist/main.js"
IPC_HELPER="$REPO_ROOT/scripts/headless-ipc.js"
STANDALONE_MODE="${INVOKER_HEADLESS_STANDALONE:-0}"

# ---------------------------------------------------------------------------
# Electron sandbox detection (Linux)
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Core transport helpers
# ---------------------------------------------------------------------------

# Read-only Electron query (stderr suppressed for clean parsing).
headless_query() {
  # shellcheck disable=SC2086
  "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@" 2>/dev/null
}

# Mutating command — delegates to the owner (standalone or IPC).
headless_mutation() {
  if [ "$STANDALONE_MODE" = "1" ]; then
    "$RUNNER" --headless "$@"
    return $?
  fi
  node "$IPC_HELPER" exec -- "$@"
}

# Extract workflow IDs (label format) from a query.
headless_workflow_ids() {
  headless_query "$@" | grep -E '^wf-[0-9]+-[0-9]+$' || true
}

# Extract task IDs (contains /) from a query.
headless_task_ids() {
  headless_query "$@" | grep '/' || true
}

# ---------------------------------------------------------------------------
# Timeout wrapper (used by rebase-retry-all.sh)
# ---------------------------------------------------------------------------

run_with_optional_timeout() {
  local seconds="$1"
  shift
  if [ "$seconds" -le 0 ]; then
    "$@"
    return $?
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$seconds" "$@" <<'PY'
import subprocess
import sys

timeout = int(sys.argv[1])
cmd = sys.argv[2:]

try:
    completed = subprocess.run(cmd, timeout=timeout, check=False)
    sys.exit(completed.returncode)
except subprocess.TimeoutExpired:
    print(f"Timed out after {timeout}s: {' '.join(cmd)}", file=sys.stderr)
    sys.exit(124)
PY
    return $?
  fi
  echo "ERROR: timeout(1), gtimeout, and python3 are unavailable; cannot enforce per-command timeout." >&2
  return 127
}

# ---------------------------------------------------------------------------
# Batch dispatch (fire-and-forget mode)
# ---------------------------------------------------------------------------

# batch_dispatch COMMANDS_FILE RESULT_FILE LOG_DIR PARALLELISM [EXTRA_BATCH_ARGS...]
#
# In standalone mode:  loops over COMMANDS_FILE, runs each serially via
#                      headless_mutation, writes results to RESULT_FILE.
# In shared-owner mode: pipes COMMANDS_FILE through `headless-ipc.js batch-exec`,
#                       then parses JSONL output into per-workflow logs and
#                       RESULT_FILE.
#
# COMMANDS_FILE format: one JSON object per line with "label", "workflowId", "args".
# RESULT_FILE format:   <workflowId>\t<SUCCEEDED|FAILED>  per line.
batch_dispatch() {
  local commands_file="$1"
  local result_file="$2"
  local log_dir="$3"
  local parallelism="$4"
  shift 4
  local extra_batch_args=("$@")

  if [ "$STANDALONE_MODE" = "1" ]; then
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      local wf_id args_json
      wf_id="$(printf '%s' "$line" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("workflowId","unknown"))')"
      args_json="$(printf '%s' "$line" | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin).get("args",[])))')"
      # shellcheck disable=SC2086
      if headless_mutation --no-track $args_json > "$log_dir/${wf_id}.log" 2>&1; then
        printf "%s\tSUCCEEDED\n" "$wf_id" >> "$result_file"
      else
        printf "%s\tFAILED\n" "$wf_id" >> "$result_file"
      fi
    done < "$commands_file"
  else
    local output_jsonl
    output_jsonl="$(mktemp -t batch-output.XXXXXX)"
    node "$IPC_HELPER" batch-exec --no-track --parallel "$parallelism" \
      "${extra_batch_args[@]}" < "$commands_file" > "$output_jsonl"
    parse_batch_results "$output_jsonl" "$result_file" "$log_dir"
    rm -f "$output_jsonl"
  fi
}

# parse_batch_results OUTPUT_JSONL RESULT_FILE LOG_DIR
#
# Reads JSONL output from batch-exec, writes per-workflow log files and a
# tab-separated result file.
parse_batch_results() {
  local output_jsonl="$1"
  local result_file="$2"
  local log_dir="$3"

  python3 - "$result_file" "$log_dir" "$output_jsonl" <<'PY'
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
}

# count_results RESULT_FILE
#
# Reads a tab-separated result file and prints three numbers to stdout:
#   <succeeded> <failed> <skipped>
count_results() {
  local result_file="$1"
  local succeeded=0
  local failed=0
  local skipped=0

  while IFS=$'\t' read -r _id result; do
    case "$result" in
      SUCCEEDED) succeeded=$((succeeded + 1)) ;;
      FAILED)    failed=$((failed + 1)) ;;
      SKIPPED)   skipped=$((skipped + 1)) ;;
    esac
  done < "$result_file"

  printf '%d %d %d\n' "$succeeded" "$failed" "$skipped"
}
