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
# Example snippet in each template (matches skills/plan-to-invoker):
#   externalDependencies:
#     - workflowId: "__UPSTREAM_WORKFLOW_ID__"
#       taskId: "__merge__"
#       requiredStatus: completed
#       gatePolicy: review_ready
#
# A gatePolicy already present in the template is preserved unless
# --gate-policy is passed explicitly; missing dependency fields are injected
# (gatePolicy defaults to completed).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not installed" >&2
  exit 1
fi

now_ms() {
  python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

log_chain() {
  local msg="$1"
  echo "[submit-workflow-chain] ${msg}"
}

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

validate_upstream_dependency_fields() {
  local file="$1"
  local upstream_id="$2"
  local gate_policy="$3"
  awk -v upid="$upstream_id" -v expected_gate="$gate_policy" '
    function normalize(v) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      gsub(/^"|"$/, "", v)
      return v
    }
    function validate_current_dep() {
      if (!in_dep || !dep_is_upstream) return
      found_upstream=1
      if (normalize(dep_taskId) != "__merge__" || normalize(dep_requiredStatus) != "completed" || normalize(dep_gatePolicy) != expected_gate) {
        invalid_upstream=1
      }
    }
    BEGIN {
      in_ext=0
      in_dep=0
      dep_is_upstream=0
      dep_taskId=""
      dep_requiredStatus=""
      dep_gatePolicy=""
      dep_gp_count=0
      found_upstream=0
      invalid_upstream=0
    }
    {
      line=$0
      if (line ~ /^[^[:space:]]/ && line !~ /^externalDependencies:[[:space:]]*$/) {
        validate_current_dep()
        in_ext=0
        in_dep=0
        dep_is_upstream=0
        next
      }
      if (line ~ /^[[:space:]]*externalDependencies:[[:space:]]*$/) {
        validate_current_dep()
        in_ext=1
        in_dep=0
        dep_is_upstream=0
        next
      }
      if (in_ext && line ~ /^[[:space:]]*-[[:space:]]*workflowId:[[:space:]]*/) {
        validate_current_dep()
        in_dep=1
        dep_taskId=""
        dep_requiredStatus=""
        dep_gatePolicy=""
        dep_gp_count=0
        split(line, parts, "workflowId:")
        dep_is_upstream=(normalize(parts[2]) == upid)
        next
      }
      if (in_ext && in_dep && dep_is_upstream && line ~ /^[[:space:]]*taskId:[[:space:]]*/) {
        split(line, parts, "taskId:")
        dep_taskId=parts[2]
        next
      }
      if (in_ext && in_dep && dep_is_upstream && line ~ /^[[:space:]]*requiredStatus:[[:space:]]*/) {
        split(line, parts, "requiredStatus:")
        dep_requiredStatus=parts[2]
        next
      }
      if (in_ext && in_dep && dep_is_upstream && line ~ /^[[:space:]]*gatePolicy:[[:space:]]*/) {
        dep_gp_count++
        if (dep_gp_count > 1) invalid_upstream=1
        split(line, parts, "gatePolicy:")
        dep_gatePolicy=parts[2]
        next
      }
    }
    END {
      validate_current_dep()
      if (!found_upstream || invalid_upstream) exit 1
    }
  ' "$file"
}

resolve_persisted_workflow_id() {
  local workflow_name="$1"
  local wf_id=""
  local start_ms
  start_ms="$(now_ms)"
  local attempt=0
  for _ in $(seq 1 30); do
    attempt=$((attempt + 1))
    wf_id="$(
      ./run.sh --headless query workflows --output json 2>/dev/null \
        | extract_json_stream \
        | jq -r --arg n "$workflow_name" '[.[] | select(.name == $n)] | sort_by(.createdAt) | last | .id // empty'
    )"
    if [[ -n "$wf_id" ]]; then
      log_chain "resolve_persisted_workflow_id name=\"$workflow_name\" found=\"$wf_id\" attempt=${attempt} elapsedMs=$(( $(now_ms) - start_ms ))" >&2
      printf '%s' "$wf_id"
      return 0
    fi
    sleep 0.2
  done
  log_chain "resolve_persisted_workflow_id name=\"$workflow_name\" failed attempts=${attempt} elapsedMs=$(( $(now_ms) - start_ms ))" >&2
  return 1
}

resolve_workflow_feature_branch() {
  local workflow_id="$1"
  local feature_branch=""
  local start_ms
  start_ms="$(now_ms)"
  local attempt=0
  for _ in $(seq 1 30); do
    attempt=$((attempt + 1))
    feature_branch="$(
      ./run.sh --headless query workflows --output json 2>/dev/null \
        | extract_json_stream \
        | jq -r --arg id "$workflow_id" '.[] | select(.id == $id) | .featureBranch // empty' \
        | head -1
    )"
    if [[ -n "$feature_branch" ]]; then
      log_chain "resolve_workflow_feature_branch workflowId=\"$workflow_id\" feature=\"$feature_branch\" attempt=${attempt} elapsedMs=$(( $(now_ms) - start_ms ))" >&2
      printf '%s' "$feature_branch"
      return 0
    fi
    sleep 0.2
  done
  log_chain "resolve_workflow_feature_branch workflowId=\"$workflow_id\" failed attempts=${attempt} elapsedMs=$(( $(now_ms) - start_ms ))" >&2
  return 1
}

wait_for_external_merge_gate() {
  local workflow_id="$1"
  local merge_id="__merge__${workflow_id}"
  local start_ms
  start_ms="$(now_ms)"
  local attempt=0
  for _ in $(seq 1 60); do
    attempt=$((attempt + 1))
    if ./run.sh --headless query tasks --output json 2>/dev/null | extract_json_stream | jq -e --arg id "$merge_id" '.[] | select(.id == $id)' >/dev/null; then
      log_chain "wait_for_external_merge_gate mergeTaskId=\"$merge_id\" found attempt=${attempt} elapsedMs=$(( $(now_ms) - start_ms ))"
      return 0
    fi
    sleep 0.2
  done
  log_chain "wait_for_external_merge_gate mergeTaskId=\"$merge_id\" timeout attempts=${attempt} elapsedMs=$(( $(now_ms) - start_ms ))"
  return 1
}

# Extract the gatePolicy value the template itself provides for the upstream
# dependency block (empty when the template has none).
extract_upstream_gate_policy() {
  local file="$1"
  local upstream_id="$2"
  awk -v upid="$upstream_id" '
    function normalize(v) {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      gsub(/^"|"$/, "", v)
      return v
    }
    BEGIN {
      in_ext=0
      dep_is_upstream=0
    }
    {
      line=$0
      if (line ~ /^[^[:space:]]/ && line !~ /^externalDependencies:[[:space:]]*$/) {
        in_ext=0
        dep_is_upstream=0
        next
      }
      if (line ~ /^[[:space:]]*externalDependencies:[[:space:]]*$/) {
        in_ext=1
        dep_is_upstream=0
        next
      }
      if (in_ext && line ~ /^[[:space:]]*-[[:space:]]*workflowId:[[:space:]]*/) {
        split(line, parts, "workflowId:")
        dep_is_upstream=(normalize(parts[2]) == upid)
        next
      }
      if (in_ext && dep_is_upstream && line ~ /^[[:space:]]*gatePolicy:[[:space:]]*/) {
        split(line, parts, "gatePolicy:")
        print normalize(parts[2])
        exit
      }
    }
  ' "$file"
}

# Render one chain-step template: substitute the upstream workflow id, enforce
# merge-gate dependency fields, validate them, and rewrite baseBranch to the
# upstream feature branch. A gatePolicy already present in the template is
# preserved unless --gate-policy was passed explicitly; missing fields are
# injected (gatePolicy falls back to GATE_POLICY).
render_chain_step_template() {
  local template="$1"
  local upstream_id="$2"
  local upstream_feature_branch="$3"
  local out="$4"

  sed "s/__UPSTREAM_WORKFLOW_ID__/$upstream_id/g" "$template" > "$out"
  if ! matches_pattern "$upstream_id" "$out"; then
    echo "Rendered plan did not include upstream id '$upstream_id': $out" >&2
    return 1
  fi

  local expected_gate="$GATE_POLICY"
  if [[ "$GATE_POLICY_EXPLICIT" -ne 1 ]]; then
    local template_gate
    template_gate="$(extract_upstream_gate_policy "$out" "$upstream_id")"
    if [[ -n "$template_gate" ]]; then
      if [[ "$template_gate" != "completed" && "$template_gate" != "review_ready" ]]; then
        echo "Template gatePolicy '$template_gate' is invalid (expected completed|review_ready): $template" >&2
        return 1
      fi
      expected_gate="$template_gate"
    fi
  fi

  # Enforce merge-gate dependency and policy for the upstream workflow entry.
  awk -v upid="$upstream_id" -v gate_policy="$GATE_POLICY" -v gate_explicit="$GATE_POLICY_EXPLICIT" '
    BEGIN {
      in_ext=0
      dep_is_upstream=0
      dep_had_taskid=0
      dep_had_required=0
      dep_had_gatepolicy=0
      dep_indent=""
    }
    function flush_dep() {
      if (!in_ext || !dep_is_upstream) return
      if (!dep_had_taskid) print dep_indent "  taskId: \"__merge__\""
      if (!dep_had_required) print dep_indent "  requiredStatus: completed"
      if (!dep_had_gatepolicy) print dep_indent "  gatePolicy: " gate_policy
    }
    {
      line=$0
      if (line ~ /^[^[:space:]]/ && line !~ /^externalDependencies:[[:space:]]*$/) {
        flush_dep()
        in_ext=0
        dep_is_upstream=0
        dep_had_taskid=0
        dep_had_required=0
        dep_had_gatepolicy=0
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
        dep_had_gatepolicy=0
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
        dep_had_gatepolicy=0
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
        dep_had_required=1
        next
      }
      if (in_ext && dep_is_upstream && line ~ /^[[:space:]]*gatePolicy:[[:space:]]*/) {
        if (gate_explicit == 1) {
          print dep_indent "  gatePolicy: " gate_policy
        } else {
          print line
        }
        dep_had_gatepolicy=1
        next
      }
      print line
    }
    END {
      flush_dep()
    }
  ' "$out" > "${out}.tmp"
  mv "${out}.tmp" "$out"

  if ! matches_pattern "workflowId:[[:space:]]*\"${upstream_id}\"([[:space:]]|$)" "$out"; then
    echo "Rendered plan missing upstream workflow dependency '${upstream_id}': $out" >&2
    return 1
  fi
  if ! validate_upstream_dependency_fields "$out" "$upstream_id" "$expected_gate"; then
    echo "Rendered plan did not enforce strict upstream merge dependency fields for '${upstream_id}' (taskId=__merge__, requiredStatus=completed, gatePolicy=${expected_gate}, no duplicates): $out" >&2
    return 1
  fi

  # Avoid sed -i (BSD vs GNU differs); write via temp file.
  sed -E "s|^baseBranch:.*$|baseBranch: ${upstream_feature_branch}|" "$out" > "${out}.tmp"
  mv "${out}.tmp" "$out"
  if ! matches_pattern "^baseBranch:[[:space:]]*${upstream_feature_branch}$" "$out"; then
    echo "Rendered plan baseBranch did not update to upstream feature branch '${upstream_feature_branch}': $out" >&2
    return 1
  fi
}

# When sourced (e.g. by render tests), expose the functions above without
# running the submission flow below.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

GATE_POLICY="completed"
GATE_POLICY_EXPLICIT=0
if [[ "${1:-}" == "--gate-policy" ]]; then
  GATE_POLICY="${2:-}"
  GATE_POLICY_EXPLICIT=1
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

    # Template must end in XXXXXX (portable mktemp; suffix .yaml breaks macOS/BSD).
    _chain_tmp="$(mktemp "${TMPDIR:-/tmp}/invoker-chain-step$((i+1)).XXXXXX")"
    submit_plan="${_chain_tmp}.yaml"
    rm -f "$_chain_tmp"
    render_chain_step_template "$plan" "$prev_wf_id" "$prev_wf_feature_branch" "$submit_plan"
    RENDERED_PLANS+=("$submit_plan")
  fi

  echo "Submitting workflow $((i+1)) (no track): $submit_plan"
  run_start_ms="$(now_ms)"
  log_chain "headless-run begin step=$((i+1)) plan=\"$submit_plan\" noTrack=true"
  _chain_out="$(mktemp "${TMPDIR:-/tmp}/invoker-chain-out$((i+1)).XXXXXX")"
  out_file="${_chain_out}.log"
  rm -f "$_chain_out"
  ./run.sh --headless run "$submit_plan" --no-track >"$out_file" 2>&1 || true
  log_chain "headless-run end step=$((i+1)) elapsedMs=$(( $(now_ms) - run_start_ms )) out=\"$out_file\""

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
