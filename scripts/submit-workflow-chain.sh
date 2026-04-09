#!/usr/bin/env bash
#
# Submit a chain of workflows headlessly:
#   workflow-2 depends on workflow-1 merge gate,
#   workflow-3 depends on workflow-2 merge gate, etc.
#
# Usage:
#   ./scripts/submit-workflow-chain.sh [--gate-policy completed|review_ready] <workflow1.yaml> <workflow2.template.yaml> [workflow3.template.yaml ...]
#
# For every plan after the first, include "__UPSTREAM_WORKFLOW_ID__" where the
# previous workflow ID should be injected.
#
# Example snippet in each template:
#   externalDependencies:
#     - workflowId: "__UPSTREAM_WORKFLOW_ID__"
#       requiredStatus: completed
#       gatePolicy: review_ready
#
set -euo pipefail

GATE_POLICY="review_ready"
if [[ "${1:-}" == "--gate-policy" ]]; then
  GATE_POLICY="${2:-}"
  shift 2
fi

if [[ "$GATE_POLICY" != "completed" && "$GATE_POLICY" != "review_ready" ]]; then
  echo "Invalid --gate-policy '$GATE_POLICY' (expected completed|review_ready)" >&2
  exit 1
fi

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 [--gate-policy completed|review_ready] <workflow1.yaml> <workflow2.template.yaml> [workflow3.template.yaml ...]" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not installed" >&2
  exit 1
fi

resolve_abs() {
  local p="$1"
  cd "$(dirname "$p")" && pwd
}

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

parse_plan_name() {
  local p="$1"
  awk '
    /^name:[[:space:]]*/ {
      line=$0
      sub(/^name:[[:space:]]*/, "", line)
      gsub(/^"|"$/, "", line)
      print line
      exit
    }
  ' "$p"
}

matches_pattern() {
  local pattern="$1"
  local file="$2"
  if command -v rg >/dev/null 2>&1; then
    rg -q "$pattern" "$file"
  else
    grep -E -q "$pattern" "$file"
  fi
}

resolve_persisted_workflow_id() {
  local workflow_name="$1"
  local wf_id=""
  for _ in $(seq 1 30); do
    wf_id="$(
      ./run.sh --headless query workflows --output json 2>/dev/null \
        | extract_json_stream \
        | jq -r --arg n "$workflow_name" '[.[] | select(.name == $n)] | sort_by(.createdAt) | last | .id // empty'
    )"
    if [[ -n "$wf_id" ]]; then
      printf '%s' "$wf_id"
      return 0
    fi
    sleep 0.2
  done
  return 1
}

resolve_workflow_feature_branch() {
  local workflow_id="$1"
  local feature_branch=""
  for _ in $(seq 1 30); do
    feature_branch="$(
      ./run.sh --headless query workflows --output json 2>/dev/null \
        | extract_json_stream \
        | jq -r --arg id "$workflow_id" '.[] | select(.id == $id) | .featureBranch // empty' \
        | head -1
    )"
    if [[ -n "$feature_branch" ]]; then
      printf '%s' "$feature_branch"
      return 0
    fi
    sleep 0.2
  done
  return 1
}

wait_for_external_merge_gate() {
  local workflow_id="$1"
  local merge_id="__merge__${workflow_id}"
  for _ in $(seq 1 60); do
    if ./run.sh --headless query tasks --output json 2>/dev/null | extract_json_stream | jq -e --arg id "$merge_id" '.[] | select(.id == $id)' >/dev/null; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

cd "$REPO_ROOT"

declare -a INPUT_PLANS=()
for p in "$@"; do
  if [[ ! -f "$p" ]]; then
    echo "Missing plan file: $p" >&2
    exit 1
  fi
  INPUT_PLANS+=("$(resolve_abs "$p")/$(basename "$p")")
done

declare -a CHAIN_WORKFLOW_IDS=()
declare -a CHAIN_BASE_BRANCHES=()
declare -a CHAIN_FEATURE_BRANCHES=()
declare -a RENDERED_PLANS=()

prev_wf_id=""
prev_wf_feature_branch=""

for i in "${!INPUT_PLANS[@]}"; do
  plan="${INPUT_PLANS[$i]}"
  plan_name="$(parse_plan_name "$plan")"
  if [[ -z "${plan_name:-}" ]]; then
    echo "Could not parse plan name from $plan (expected top-level 'name:')" >&2
    exit 1
  fi

  submit_plan="$plan"
  if [[ "$i" -gt 0 ]]; then
    if [[ -z "$prev_wf_id" ]]; then
      echo "Internal error: missing previous workflow id before rendering chain step $((i+1))." >&2
      exit 1
    fi
    if ! matches_pattern "__UPSTREAM_WORKFLOW_ID__" "$plan"; then
      echo "Template plan is missing __UPSTREAM_WORKFLOW_ID__: $plan" >&2
      exit 1
    fi
    if [[ -z "$prev_wf_feature_branch" ]]; then
      echo "Internal error: missing previous workflow feature branch before rendering chain step $((i+1))." >&2
      exit 1
    fi
    if ! wait_for_external_merge_gate "$prev_wf_id"; then
      echo "Upstream merge gate not found yet: __merge__${prev_wf_id}" >&2
      exit 1
    fi
    if ! matches_pattern "^baseBranch:" "$plan"; then
      echo "Template plan is missing top-level baseBranch: $plan" >&2
      exit 1
    fi

    submit_plan="$(mktemp "/tmp/invoker-chain-step$((i+1)).XXXXXX.yaml")"
    sed "s/__UPSTREAM_WORKFLOW_ID__/$prev_wf_id/g" "$plan" > "$submit_plan"
    if ! matches_pattern "$prev_wf_id" "$submit_plan"; then
      echo "Rendered plan did not include upstream id '$prev_wf_id': $submit_plan" >&2
      exit 1
    fi

    # Enforce merge-gate dependency and policy for the upstream workflow entry.
    awk -v upid="$prev_wf_id" -v gate_policy="$GATE_POLICY" '
      BEGIN {
        in_ext=0
        dep_is_upstream=0
        dep_had_taskid=0
        dep_had_required=0
        dep_indent=""
      }
      function flush_dep() {
        if (!in_ext || !dep_is_upstream) return
        if (!dep_had_taskid) print dep_indent "  taskId: \"__merge__\""
        if (!dep_had_required) print dep_indent "  requiredStatus: completed"
      }
      {
        line=$0
        if (line ~ /^[^[:space:]]/ && line !~ /^externalDependencies:[[:space:]]*$/) {
          flush_dep()
          in_ext=0
          dep_is_upstream=0
          dep_had_taskid=0
          dep_had_required=0
          dep_indent=""
          print line
          next
        }
        if (line ~ /^[[:space:]]*externalDependencies:[[:space:]]*$/) {
          flush_dep()
          in_ext=1
          dep_is_upstream=0
          dep_had_taskid=0
          dep_had_required=0
          dep_indent=""
          print line
          next
        }
        if (in_ext && line ~ /^[[:space:]]*-[[:space:]]*workflowId:[[:space:]]*/) {
          flush_dep()
          dep_indent=substr(line, 1, index(line, "-")-1)
          dep_is_upstream=(line ~ ("workflowId:[[:space:]]*\"" upid "\"([[:space:]]|$)"))
          dep_had_taskid=0
          dep_had_required=0
          print line
          next
        }
        if (in_ext && dep_is_upstream && line ~ /^[[:space:]]*taskId:[[:space:]]*/) {
          print dep_indent "  taskId: \"__merge__\""
          dep_had_taskid=1
          next
        }
        if (in_ext && dep_is_upstream && line ~ /^[[:space:]]*requiredStatus:[[:space:]]*/) {
          print dep_indent "  requiredStatus: completed"
          print dep_indent "  gatePolicy: " gate_policy
          dep_had_required=1
          next
        }
        print line
      }
      END {
        flush_dep()
      }
    ' "$submit_plan" > "${submit_plan}.tmp"
    mv "${submit_plan}.tmp" "$submit_plan"

    if ! matches_pattern "workflowId:[[:space:]]*\"${prev_wf_id}\"([[:space:]]|$)" "$submit_plan"; then
      echo "Rendered plan missing upstream workflow dependency '${prev_wf_id}': $submit_plan" >&2
      exit 1
    fi
    if ! matches_pattern "taskId:[[:space:]]*\"__merge__\"" "$submit_plan"; then
      echo "Rendered plan missing enforced merge-gate taskId '__merge__': $submit_plan" >&2
      exit 1
    fi
    if ! matches_pattern "^[[:space:]]*gatePolicy:[[:space:]]*${GATE_POLICY}$" "$submit_plan"; then
      echo "Rendered plan missing enforced gatePolicy '${GATE_POLICY}': $submit_plan" >&2
      exit 1
    fi

    sed -E -i "s|^baseBranch:.*$|baseBranch: ${prev_wf_feature_branch}|" "$submit_plan"
    if ! matches_pattern "^baseBranch:[[:space:]]*${prev_wf_feature_branch}$" "$submit_plan"; then
      echo "Rendered plan baseBranch did not update to upstream feature branch '${prev_wf_feature_branch}': $submit_plan" >&2
      exit 1
    fi
    RENDERED_PLANS+=("$submit_plan")
  fi

  echo "Submitting workflow $((i+1)) (no track): $submit_plan"
  out_file="$(mktemp "/tmp/invoker-chain-step$((i+1)).XXXXXX.log")"
  ./run.sh --headless run "$submit_plan" --no-track >"$out_file" 2>&1 || true

  printed_id="$(awk '/Workflow ID:/{print $3}' "$out_file" | tail -1)"
  delegated_id="$(sed -n 's/.*workflow: \(wf-[0-9]\+-[0-9]\+\).*/\1/p' "$out_file" | tail -1)"
  if [[ -n "${printed_id:-}" || -n "${delegated_id:-}" ]]; then
    echo "  printed_id=${printed_id:-<none>} delegated_id=${delegated_id:-<none>}"
  fi

  persisted_id="$(resolve_persisted_workflow_id "$plan_name" || true)"
  if [[ -z "${persisted_id:-}" ]]; then
    echo "Failed to resolve persisted workflow id for name: $plan_name" >&2
    echo "Headless output tail:" >&2
    tail -n 40 "$out_file" >&2 || true
    exit 1
  fi

  CHAIN_WORKFLOW_IDS+=("$persisted_id")
  wf_base_branch="$(
    ./run.sh --headless query workflows --output json 2>/dev/null \
      | extract_json_stream \
      | jq -r --arg id "$persisted_id" '.[] | select(.id == $id) | .baseBranch // empty' | head -1
  )"
  CHAIN_BASE_BRANCHES+=("${wf_base_branch:-<unset>}")

  wf_feature_branch="$(resolve_workflow_feature_branch "$persisted_id" || true)"
  if [[ -z "${wf_feature_branch:-}" ]]; then
    echo "Failed to resolve featureBranch for workflow: $persisted_id (name: $plan_name)" >&2
    exit 1
  fi
  CHAIN_FEATURE_BRANCHES+=("$wf_feature_branch")
  prev_wf_feature_branch="$wf_feature_branch"
  prev_wf_id="$persisted_id"
done

echo
echo "Workflow chain submitted."
echo "GATE_POLICY=${GATE_POLICY}"
for i in "${!CHAIN_WORKFLOW_IDS[@]}"; do
  echo "WF$((i+1))=${CHAIN_WORKFLOW_IDS[$i]} base=${CHAIN_BASE_BRANCHES[$i]} feature=${CHAIN_FEATURE_BRANCHES[$i]}"
done
for p in "${RENDERED_PLANS[@]}"; do
  echo "RENDERED_PLAN=$p"
done
