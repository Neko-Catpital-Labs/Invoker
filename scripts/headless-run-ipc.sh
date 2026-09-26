#!/usr/bin/env bash
set -euo pipefail

socket_path="${1:-}"
plan_path="${2:-}"
if [ -z "$socket_path" ] || [ -z "$plan_path" ]; then
  echo "Usage: scripts/headless-run-ipc.sh <socket> <plan.yaml>" >&2
  exit 2
fi

if ! command -v nc >/dev/null 2>&1; then
  echo "[headless-run-ipc] nc is required for the fast owner-delegation path" >&2
  exit 2
fi

if [ "${plan_path#/}" = "$plan_path" ]; then
  plan_path="$(pwd)/$plan_path"
fi

set +e
response="$(
  {
    printf '%s\n' "$plan_path"
  } | nc -U -w 30 "$socket_path" | sed -n '1p'
)"
status=$?
set -e
if [ "$status" -ne 0 ]; then
  echo "[headless-run-ipc] planPath=\"$plan_path\" failed: owner socket request exited $status" >&2
  exit "$status"
fi

if [[ "$response" == err\ * ]]; then
  echo "[headless-run-ipc] planPath=\"$plan_path\" failed: ${response#err }" >&2
  exit 1
fi

if [[ "$response" =~ ^ok\ (wf-[^[:space:]]+) ]]; then
  workflow_id="${BASH_REMATCH[1]}"
  echo "Delegated to owner - workflow: $workflow_id"
  echo "--no-track enabled: delegated submission accepted; exiting without tracking."
  exit 0
fi

echo "[headless-run-ipc] planPath=\"$plan_path\" failed: headless.run returned no workflowId: $response" >&2
exit 1
