#!/usr/bin/env bash
#
# Submit two workflows headlessly where workflow-2 depends on workflow-1 merge gate.
#
# Usage:
#   ./scripts/submit-workflow-chain.sh <workflow1.yaml> <workflow2.template.yaml>
#
# The second file must contain the placeholder "__UPSTREAM_WORKFLOW_ID__" where
# the upstream workflow ID should be injected.
#
# Example snippet in workflow2 template:
#   externalDependencies:
#     - workflowId: "__UPSTREAM_WORKFLOW_ID__"
#       requiredStatus: completed
#
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <workflow1.yaml> <workflow2.template.yaml>" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN1_IN="$1"
PLAN2_TEMPLATE_IN="$2"

if [[ ! -f "$PLAN1_IN" ]]; then
  echo "Missing workflow1 plan: $PLAN1_IN" >&2
  exit 1
fi
if [[ ! -f "$PLAN2_TEMPLATE_IN" ]]; then
  echo "Missing workflow2 template: $PLAN2_TEMPLATE_IN" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not installed" >&2
  exit 1
fi

PLAN1="$(cd "$(dirname "$PLAN1_IN")" && pwd)/$(basename "$PLAN1_IN")"
PLAN2_TEMPLATE="$(cd "$(dirname "$PLAN2_TEMPLATE_IN")" && pwd)/$(basename "$PLAN2_TEMPLATE_IN")"

# Parse "name:" from YAML without extra deps.
PLAN1_NAME="$(awk -F': *' '/^name:/{v=$2; gsub(/^"|"$/, "", v); print v; exit}' "$PLAN1")"
if [[ -z "${PLAN1_NAME:-}" ]]; then
  echo "Could not parse plan name from $PLAN1 (expected top-level 'name:')" >&2
  exit 1
fi

cd "$REPO_ROOT"

echo "Submitting workflow 1 (no track): $PLAN1"
OUT1_FILE="$(mktemp /tmp/invoker-chain-wf1.XXXXXX.log)"
./run.sh --headless run "$PLAN1" --no-track >"$OUT1_FILE" 2>&1 || true

WF1_PRINTED="$(awk '/Workflow ID:/{print $3}' "$OUT1_FILE" | tail -1)"
if [[ -n "${WF1_PRINTED:-}" ]]; then
  echo "Workflow 1 printed ID: $WF1_PRINTED"
fi

# Resolve persisted workflow 1 ID by exact name (most recent).
WF1=""
for _ in $(seq 1 30); do
  WF1="$(
    ./run.sh --headless query workflows --output json 2>/dev/null \
      | jq -r --arg n "$PLAN1_NAME" '[.[] | select(.name == $n)] | sort_by(.createdAt) | last | .id // empty'
  )"
  if [[ -n "$WF1" ]]; then
    break
  fi
  sleep 0.2
done

if [[ -z "$WF1" ]]; then
  echo "Failed to resolve persisted workflow1 id for name: $PLAN1_NAME" >&2
  echo "Headless output tail:" >&2
  tail -n 40 "$OUT1_FILE" >&2 || true
  exit 1
fi

PLAN2_RENDERED="$(mktemp /tmp/invoker-chain-wf2.XXXXXX.yaml)"
sed "s/__UPSTREAM_WORKFLOW_ID__/$WF1/g" "$PLAN2_TEMPLATE" > "$PLAN2_RENDERED"

if ! rg -q "$WF1" "$PLAN2_RENDERED"; then
  echo "Rendered workflow2 did not contain upstream workflow id: $WF1" >&2
  exit 1
fi

echo "Submitting workflow 2 (no track): $PLAN2_RENDERED"
OUT2_FILE="$(mktemp /tmp/invoker-chain-wf2.XXXXXX.log)"
./run.sh --headless run "$PLAN2_RENDERED" --no-track >"$OUT2_FILE" 2>&1 || true

WF2_DELEGATED="$(sed -n 's/.*workflow: \(wf-[0-9]\+-[0-9]\+\).*/\1/p' "$OUT2_FILE" | tail -1)"
WF2_PRINTED="$(awk '/Workflow ID:/{print $3}' "$OUT2_FILE" | tail -1)"
WF2="${WF2_DELEGATED:-$WF2_PRINTED}"

echo
echo "Workflow chain submitted."
echo "WF1=$WF1"
echo "WF2=${WF2:-<unknown>}"
echo "PLAN2_RENDERED=$PLAN2_RENDERED"

