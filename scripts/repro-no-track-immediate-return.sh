#!/usr/bin/env bash
# Repro/Correctness check: --no-track must return immediately on headless submit
# even in standalone fallback mode.
#
# Pass criteria:
#   1) `run --headless run <plan> --no-track` exits 0 (not timeout)
#   2) command returns under MAX_RETURN_MS (default: 8000 ms)
#   3) returned output includes a workflow id
#   4) right after return, the long task is still pending/running/fixing_with_ai
#
# Usage:
#   bash scripts/repro-no-track-immediate-return.sh
#
# Optional env overrides:
#   MAX_RETURN_MS=12000 SLEEP_SECONDS=120 TIMEOUT_SECONDS=45 bash scripts/repro-no-track-immediate-return.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
MAX_RETURN_MS="${MAX_RETURN_MS:-8000}"
SLEEP_SECONDS="${SLEEP_SECONDS:-90}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-40}"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "FAIL: required command not found: $1"
    exit 1
  fi
}

require jq
require timeout

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

PLAN_NAME="repro-no-track-$(date +%s)"
PLAN_FILE="$(mktemp /tmp/${PLAN_NAME}.XXXXXX.yaml)"
OUT_FILE="$(mktemp /tmp/${PLAN_NAME}.XXXXXX.log)"

cleanup() {
  rm -f "$PLAN_FILE" "$OUT_FILE" 2>/dev/null || true
}
trap cleanup EXIT

cat > "$PLAN_FILE" <<YAML
name: "$PLAN_NAME"
repoUrl: git@github.com:EdbertChan/Invoker.git
onFinish: none
mergeMode: manual
baseBranch: master
tasks:
  - id: long-sleep
    description: "Long running task for --no-track immediate return repro"
    command: |
      set -euo pipefail
      sleep $SLEEP_SECONDS
YAML

cd "$REPO_ROOT"

echo "==> Repro: --no-track immediate return (standalone headless)"
echo "    plan=$PLAN_FILE"
echo "    max_return_ms=$MAX_RETURN_MS sleep_seconds=$SLEEP_SECONDS timeout_seconds=$TIMEOUT_SECONDS"

start_ms="$(date +%s%3N)"
set +e
INVOKER_HEADLESS_STANDALONE=1 timeout "$TIMEOUT_SECONDS" ./run.sh --headless run "$PLAN_FILE" --no-track >"$OUT_FILE" 2>&1
rc=$?
set -e
end_ms="$(date +%s%3N)"
elapsed_ms=$((end_ms - start_ms))

wf_id="$(sed -n 's/^Workflow ID: \(wf-[0-9-]*\)$/\1/p' "$OUT_FILE" | tail -1)"
if [[ -z "$wf_id" ]]; then
  wf_id="$(sed -n 's/.*workflow: \(wf-[0-9-]*\).*/\1/p' "$OUT_FILE" | tail -1)"
fi

if [[ "$rc" -eq 124 ]]; then
  echo "FAIL: submit timed out after ${TIMEOUT_SECONDS}s (did not return immediately)"
  echo "--- output tail ---"
  tail -n 40 "$OUT_FILE" || true
  exit 1
fi

if [[ "$rc" -ne 0 ]]; then
  echo "FAIL: submit exited with rc=$rc"
  echo "--- output tail ---"
  tail -n 40 "$OUT_FILE" || true
  exit 1
fi

if [[ -z "$wf_id" ]]; then
  echo "FAIL: workflow id not found in submit output"
  echo "--- output ---"
  cat "$OUT_FILE" || true
  exit 1
fi

if (( elapsed_ms > MAX_RETURN_MS )); then
  echo "FAIL: --no-track submit took too long (${elapsed_ms}ms > ${MAX_RETURN_MS}ms)"
  echo "workflow_id=$wf_id"
  echo "--- output tail ---"
  tail -n 60 "$OUT_FILE" || true
  exit 1
fi

task_id="${wf_id}/long-sleep"
status=""
for _ in $(seq 1 24); do
  status="$( (./run.sh --headless query tasks --output json 2>/dev/null || true) | extract_json_stream | jq -r --arg id "$task_id" '.[] | select(.id == $id) | .status' | head -1 )"
  if [[ -n "$status" ]]; then
    break
  fi
  sleep 0.25
done

if [[ -z "$status" ]]; then
  echo "FAIL: could not resolve task status for $task_id right after submit"
  exit 1
fi

case "$status" in
  pending|running|fixing_with_ai)
    ;;
  *)
    echo "FAIL: expected task to still be pending/running after immediate return, got status='$status'"
    exit 1
    ;;
esac

echo "PASS: --no-track returned immediately and did not wait for workflow completion"
echo "workflow_id=$wf_id"
echo "elapsed_ms=$elapsed_ms"
echo "task_status_after_return=$status"
