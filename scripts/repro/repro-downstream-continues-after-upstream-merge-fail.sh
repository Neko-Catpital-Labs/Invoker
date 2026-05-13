#!/usr/bin/env bash
# Repro: downstream workflow can continue even if upstream merge gate is not completed
# when cross-workflow dependency uses gatePolicy=review_ready.
#
# This script runs two cases against an isolated DB + local temp git repo:
#  1) review_ready: downstream starts before upstream merge gate reaches completed.
#  2) completed: downstream stays pending until upstream merge gate reaches completed.
#
# Usage:
#   bash scripts/repro/repro-downstream-continues-after-upstream-merge-fail.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-merge-gate.XXXXXX")"
DB_DIR="$TMP_ROOT/db"
PLAN_DIR="$TMP_ROOT/plans"
REPO_DIR="$TMP_ROOT/repo"
LOG_DIR="$TMP_ROOT/logs"
RUN_ID="${REPRO_MERGE_GATE_RUN_ID:-$(date +%Y%m%d%H%M%S)}"

cleanup() {
  local ec=$?
  rm -rf "$TMP_ROOT"
  return "$ec"
}
trap cleanup EXIT

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_cmd git
require_cmd jq

mkdir -p "$DB_DIR" "$PLAN_DIR" "$LOG_DIR"

export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_DB_DIR="$DB_DIR"
export INVOKER_ALLOW_DELETE_ALL=1

extract_json_stream() {
  awk '
    BEGIN { started = 0 }
    {
      if (!started) {
        if ($0 ~ /^[[:space:]]*[\[{]/ && $0 !~ /^\[init\]/ && $0 !~ /^\[deprecated\]/) {
          started = 1
          print
        }
      } else {
        print
      }
    }
  '
}

headless() {
  (
    cd "$ROOT"
    ./run.sh --headless "$@"
  )
}

query_tasks_json() {
  headless query tasks --output json 2>/dev/null | extract_json_stream
}

query_workflows_json() {
  headless query workflows --output json 2>/dev/null | extract_json_stream
}

resolve_workflow_id_by_name() {
  local workflow_name="$1"
  for _ in $(seq 1 120); do
    local id
    id="$(
      query_workflows_json |
        jq -r --arg name "$workflow_name" '[.[] | select(.name == $name)] | sort_by(.createdAt) | last | .id // empty'
    )"
    if [[ -n "$id" ]]; then
      printf '%s' "$id"
      return 0
    fi
    sleep 0.25
  done
  return 1
}

submit_plan_and_resolve_workflow_id() {
  local plan_path="$1"
  local workflow_name="$2"
  local log_path="$3"
  python3 - "$ROOT" "$plan_path" "$log_path" <<'PY'
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1])
plan_path = sys.argv[2]
log_path = Path(sys.argv[3])
cmd = ["./run.sh", "--headless", "run", plan_path]

with log_path.open("w", encoding="utf-8") as f:
    try:
        subprocess.run(
            cmd,
            cwd=root,
            stdout=f,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=45,
        )
    except subprocess.TimeoutExpired:
        f.write("\n[repro] submit command timed out after 45s\n")
PY
  local workflow_id
  workflow_id="$(resolve_workflow_id_by_name "$workflow_name" || true)"
  if [[ -z "$workflow_id" ]]; then
    echo "failed to resolve workflow id for name: $workflow_name" >&2
    echo "--- submit log ($log_path) ---" >&2
    cat "$log_path" >&2
    return 1
  fi
  printf '%s' "$workflow_id"
}

wait_workflow_exists() {
  local workflow_id="$1"
  for _ in $(seq 1 120); do
    if query_workflows_json | jq -e --arg id "$workflow_id" '.[] | select(.id == $id)' >/dev/null; then
      return 0
    fi
    sleep 0.25
  done
  echo "workflow did not appear: $workflow_id" >&2
  return 1
}

wait_for_task_status() {
  local task_id="$1"
  local expected="$2"
  for _ in $(seq 1 300); do
    local status
    status="$(task_status "$task_id")"
    if [[ "$status" == "$expected" ]]; then
      return 0
    fi
    sleep 0.25
  done
  echo "task $task_id did not reach $expected" >&2
  headless query task "$task_id" --output json >&2 || true
  return 1
}

wait_for_any_status() {
  local task_id="$1"
  shift
  for _ in $(seq 1 300); do
    local status
    status="$(task_status "$task_id")"
    for candidate in "$@"; do
      if [[ "$status" == "$candidate" ]]; then
        printf '%s' "$status"
        return 0
      fi
    done
    sleep 0.25
  done
  echo "task $task_id did not reach any target status: $*" >&2
  return 1
}

task_status() {
  local task_id="$1"
  headless query task "$task_id" 2>/dev/null | tr -d '\r' | tail -1
}

create_temp_repo() {
  mkdir -p "$REPO_DIR"
  (
    cd "$REPO_DIR"
    git init -q
    git checkout -q -b main
    printf '%s\n' "# merge-gate repro" > README.md
    printf '%s\n' '{"name":"merge-gate-repro","version":"1.0.0","private":true}' > package.json
    git add README.md package.json
    git -c user.name='repro' -c user.email='repro@example.com' commit -q -m 'init repro repo'
  )
}

write_upstream_plan() {
  local plan_path="$1"
  cat > "$plan_path" <<EOF
name: "repro-upstream-${RUN_ID}"
description: "Upstream workflow that reaches merge gate review."
repoUrl: "file://${REPO_DIR}"
baseBranch: main
onFinish: merge
mergeMode: manual
tasks:
  - id: upstream-task
    description: "Create upstream marker"
    command: "printf '%s\n' upstream-${RUN_ID} >> README.md"
    dependencies: []
EOF
}

write_downstream_plan() {
  local plan_path="$1"
  local upstream_workflow_id="$2"
  local gate_policy="$3"
  cat > "$plan_path" <<EOF
name: "repro-downstream-${gate_policy}-${RUN_ID}"
description: "Downstream workflow gated on upstream merge task."
repoUrl: "file://${REPO_DIR}"
baseBranch: main
onFinish: none
mergeMode: manual
tasks:
  - id: downstream-task
    description: "Long-running task so we can observe dependency gating"
    command: "sleep 12"
    dependencies: []
    externalDependencies:
      - workflowId: "${upstream_workflow_id}"
        taskId: "__merge__"
        requiredStatus: completed
        gatePolicy: ${gate_policy}
EOF
}

run_case() {
  local gate_policy="$1"
  local upstream_plan="$PLAN_DIR/upstream-${gate_policy}.yaml"
  local downstream_plan="$PLAN_DIR/downstream-${gate_policy}.yaml"
  local upstream_name="repro-upstream-${RUN_ID}"
  local downstream_name="repro-downstream-${gate_policy}-${RUN_ID}"

  echo "==> case: gatePolicy=${gate_policy}"
  write_upstream_plan "$upstream_plan"
  local upstream_wf
  upstream_wf="$(
    submit_plan_and_resolve_workflow_id \
      "$upstream_plan" \
      "$upstream_name" \
      "$LOG_DIR/upstream-${gate_policy}.log"
  )"
  wait_workflow_exists "$upstream_wf"

  local upstream_merge="__merge__${upstream_wf}"
  local upstream_leaf="${upstream_wf}/upstream-task"
  wait_for_task_status "$upstream_leaf" "completed"
  local merge_ready_status
  merge_ready_status="$(wait_for_any_status "$upstream_merge" "review_ready" "awaiting_approval")"
  echo "   upstream merge gate reached: ${merge_ready_status}"

  write_downstream_plan "$downstream_plan" "$upstream_wf" "$gate_policy"
  local downstream_wf
  downstream_wf="$(
    submit_plan_and_resolve_workflow_id \
      "$downstream_plan" \
      "$downstream_name" \
      "$LOG_DIR/downstream-${gate_policy}.log"
  )"
  wait_workflow_exists "$downstream_wf"

  local downstream_task="${downstream_wf}/downstream-task"
  if [[ "$gate_policy" == "review_ready" ]]; then
    local started_status
    started_status="$(wait_for_any_status "$downstream_task" "running" "completed")"
    echo "   downstream started under review_ready dependency: ${started_status}"
  else
    sleep 2
    local pending_status
    pending_status="$(task_status "$downstream_task")"
    echo "   downstream status before upstream completion: ${pending_status}"
    if [[ "$pending_status" != "pending" ]]; then
      echo "expected downstream to remain pending for gatePolicy=completed, got ${pending_status}" >&2
      return 1
    fi
  fi

  local upstream_merge_after
  upstream_merge_after="$(task_status "$upstream_merge")"
  local downstream_after
  downstream_after="$(task_status "$downstream_task")"
  echo "   upstream merge gate status now: ${upstream_merge_after}"
  echo "   downstream status now: ${downstream_after}"

  if [[ "$gate_policy" == "review_ready" ]]; then
    if [[ "$upstream_merge_after" == "completed" ]]; then
      echo "expected upstream merge gate to still be non-completed for review_ready case" >&2
      return 1
    fi
    if [[ "$downstream_after" == "pending" || "$downstream_after" == "blocked" ]]; then
      echo "expected downstream to continue under review_ready before upstream completion" >&2
      return 1
    fi
  else
    if [[ "$upstream_merge_after" != "review_ready" && "$upstream_merge_after" != "awaiting_approval" ]]; then
      echo "expected upstream merge gate to remain review_ready/awaiting_approval for completed policy case" >&2
      return 1
    fi
    if [[ "$downstream_after" != "pending" ]]; then
      echo "expected downstream to stay pending under completed policy before upstream completion, got ${downstream_after}" >&2
      return 1
    fi
  fi

  echo "   result: PASS gatePolicy=${gate_policy}"
}

create_temp_repo
headless delete-all >/dev/null 2>&1 || true

run_case "review_ready"
run_case "completed"

echo
echo "PASS repro-downstream-continues-after-upstream-merge-fail"
