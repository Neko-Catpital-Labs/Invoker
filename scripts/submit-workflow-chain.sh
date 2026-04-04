#!/usr/bin/env bash
#
# Submit a chain of workflows headlessly:
#   workflow-2 depends on workflow-1 merge gate,
#   workflow-3 depends on workflow-2 merge gate, etc.
#
# Usage:
#   ./scripts/submit-workflow-chain.sh <workflow1.yaml> <workflow2.template.yaml> [workflow3.template.yaml ...]
#
# For every plan after the first, include "__UPSTREAM_WORKFLOW_ID__" where the
# previous workflow ID should be injected.
#
# Example snippet in each template:
#   externalDependencies:
#     - workflowId: "__UPSTREAM_WORKFLOW_ID__"
#       requiredStatus: completed
#
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <workflow1.yaml> <workflow2.template.yaml> [workflow3.template.yaml ...]" >&2
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

parse_plan_name() {
  local p="$1"
  awk -F': *' '/^name:/{v=$2; gsub(/^"|"$/, "", v); print v; exit}' "$p"
}

resolve_persisted_workflow_id() {
  local workflow_name="$1"
  local wf_id=""
  for _ in $(seq 1 30); do
    wf_id="$(
      ./run.sh --headless query workflows --output json 2>/dev/null \
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
declare -a RENDERED_PLANS=()

prev_wf_id=""

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
    if ! rg -q "__UPSTREAM_WORKFLOW_ID__" "$plan"; then
      echo "Template plan is missing __UPSTREAM_WORKFLOW_ID__: $plan" >&2
      exit 1
    fi
    submit_plan="$(mktemp "/tmp/invoker-chain-step$((i+1)).XXXXXX.yaml")"
    sed "s/__UPSTREAM_WORKFLOW_ID__/$prev_wf_id/g" "$plan" > "$submit_plan"
    if ! rg -q "$prev_wf_id" "$submit_plan"; then
      echo "Rendered plan did not include upstream id '$prev_wf_id': $submit_plan" >&2
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
  prev_wf_id="$persisted_id"
done

echo
echo "Workflow chain submitted."
for i in "${!CHAIN_WORKFLOW_IDS[@]}"; do
  echo "WF$((i+1))=${CHAIN_WORKFLOW_IDS[$i]}"
done
for p in "${RENDERED_PLANS[@]}"; do
  echo "RENDERED_PLAN=$p"
done
