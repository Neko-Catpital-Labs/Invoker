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
ELECTRON="$REPO_ROOT/scripts/electron.cjs"
if [[ -n "${INVOKER_HEADLESS_ELECTRON_BIN:-}" ]]; then
  ELECTRON="$INVOKER_HEADLESS_ELECTRON_BIN"
fi
MAIN="$REPO_ROOT/packages/app/dist/main.js"
IPC_HELPER="$REPO_ROOT/scripts/headless-ipc.js"
if [[ -n "${INVOKER_HEADLESS_IPC_HELPER:-}" ]]; then
  IPC_HELPER="$INVOKER_HEADLESS_IPC_HELPER"
fi
STANDALONE_MODE="${INVOKER_HEADLESS_STANDALONE:-0}"
FORCE_OWNER_IPC="${INVOKER_HEADLESS_FORCE_OWNER_IPC:-0}"

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
#
# Bounded by INVOKER_HEADLESS_QUERY_TIMEOUT_SECONDS (default 60; 0 disables).
# Safe to kill on timeout: this only runs `query` subcommands, which never
# write to the DB, so there is no stuck-row risk the way there is for
# headless_mutation (see run_with_optional_timeout's use in rebase-retry-all.sh
# for that different, deliberately-timeout-free case).
headless_query() {
  local seconds="${INVOKER_HEADLESS_QUERY_TIMEOUT_SECONDS:-60}"
  local status=0
  # shellcheck disable=SC2086
  run_with_optional_timeout "$seconds" "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless "$@" 2>/dev/null || status=$?
  case "$status" in
    124)
      echo "ERROR: headless_query timed out after ${seconds}s (query subprocess killed; owner may be crashed/unresponsive). Override with INVOKER_HEADLESS_QUERY_TIMEOUT_SECONDS=<seconds>, or =0 to disable. args: $*" >&2
      ;;
    127)
      echo "ERROR: headless_query could not enforce a timeout (timeout/gtimeout/python3 all unavailable); query ran without a bound." >&2
      ;;
  esac
  return "$status"
}

# Mutating command — delegates to the owner (standalone or IPC).
headless_mutation() {
  local ipc_args=()
  local headless_args=()

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --no-track|--do-not-track)
        ipc_args+=(--no-track)
        shift
        ;;
      --wait-for-approval)
        ipc_args+=(--wait-for-approval)
        shift
        ;;
      --timeout-ms)
        if [ "$#" -lt 2 ]; then
          echo "ERROR: --timeout-ms requires a value" >&2
          return 2
        fi
        ipc_args+=(--timeout-ms "$2")
        shift 2
        ;;
      --)
        shift
        headless_args+=("$@")
        break
        ;;
      *)
        headless_args+=("$1")
        shift
        ;;
    esac
  done

  if [ "$STANDALONE_MODE" = "1" ] && [ "$FORCE_OWNER_IPC" != "1" ]; then
    "$RUNNER" --headless "${ipc_args[@]}" "${headless_args[@]}"
    return $?
  fi
  INVOKER_HEADLESS_REQUIRE_EXISTING_OWNER=1 node "$IPC_HELPER" exec "${ipc_args[@]}" -- "${headless_args[@]}"
}

# Extract workflow IDs (label format) from a query.
headless_workflow_ids() {
  if [[ -n "${INVOKER_HEADLESS_WORKFLOW_IDS_FILE:-}" ]]; then
    grep -E '^wf-[0-9]+-[0-9]+$' "$INVOKER_HEADLESS_WORKFLOW_IDS_FILE" || true
    return
  fi
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
    timeout -k 5 "$seconds" "$@"
    return $?
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout -k 5 "$seconds" "$@"
    return $?
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$seconds" "$@" <<'PY'
import os
import signal
import subprocess
import sys

timeout = int(sys.argv[1])
cmd = sys.argv[2:]

proc = subprocess.Popen(cmd, start_new_session=True)
try:
    sys.exit(proc.wait(timeout=timeout))
except subprocess.TimeoutExpired:
    print(f"Timed out after {timeout}s: {' '.join(cmd)}", file=sys.stderr)
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait()
    except ProcessLookupError:
        pass
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

  if [ "$STANDALONE_MODE" = "1" ] && [ "$FORCE_OWNER_IPC" != "1" ]; then
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
    # With `set -u`, `"${extra_batch_args[@]}"` errors when the array is empty
    # (no optional batch-exec args). Branch avoids unbound expansion.
    local batch_timeout_seconds="${INVOKER_HEADLESS_BATCH_TIMEOUT_SECONDS:-300}"
    if [[ ${#extra_batch_args[@]} -gt 0 ]]; then
      run_with_optional_timeout "$batch_timeout_seconds" \
        node "$IPC_HELPER" batch-exec --no-track --parallel "$parallelism" \
        "${extra_batch_args[@]}" < "$commands_file" > "$output_jsonl"
    else
      run_with_optional_timeout "$batch_timeout_seconds" \
        node "$IPC_HELPER" batch-exec --no-track --parallel "$parallelism" \
        < "$commands_file" > "$output_jsonl"
    fi
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
    response = item.get("response")
    queued = (
        item.get("ok") is True
        and isinstance(response, dict)
        and (
            (response.get("ok") is True and response.get("intentId") not in (None, ""))
            or response.get("workflowId") not in (None, "")
        )
    )
    (log_dir / f"{workflow_id}.log").write_text(raw + "\n", encoding="utf-8")
    with result_file.open("a", encoding="utf-8") as handle:
        handle.write(f"{workflow_id}\t{'SUCCEEDED' if queued else 'FAILED'}\n")
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
