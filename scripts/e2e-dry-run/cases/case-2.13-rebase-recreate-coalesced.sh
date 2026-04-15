#!/usr/bin/env bash
# Group 2.13 — concurrent rebase + recreate requests on same workflow coalesce to one effective reset.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib/common.sh"

invoker_e2e_init
trap invoker_e2e_cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE
CFG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-e2e-config.XXXXXX.json")"
printf '{}\n' > "$CFG_FILE"
export INVOKER_REPO_CONFIG_PATH="$CFG_FILE"

echo "==> case 2.13: delete-all"
invoker_e2e_run_headless delete-all

echo "==> case 2.13: submit plan (A fails)"
invoker_e2e_submit_plan "$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.13-rebase-recreate-race.yaml" || true

STA=$(invoker_e2e_task_status e2e-g2213-taskA)
STB=$(invoker_e2e_task_status e2e-g2213-taskB)
if [ "$STA" != "failed" ] || [ "$STB" != "pending" ]; then
  echo "FAIL case 2.13: expected A=failed B=pending, got A='$STA' B='$STB'"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

WF_ID="$(invoker_e2e_run_headless query workflows --output label | grep -E '^wf-[0-9]+-[0-9]+$' | tail -1)"
TASK_ID="$(invoker_e2e_run_headless query tasks --workflow "$WF_ID" --no-merge --output label | grep '/' | head -1)"
if [ -z "${WF_ID:-}" ] || [ -z "${TASK_ID:-}" ]; then
  echo "FAIL case 2.13: could not resolve workflow/task ids"
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

generation_for_workflow() {
  local wf_id="$1"
  invoker_e2e_run_headless query workflows --output jsonl \
    | grep '^{' \
    | jq -sr --arg wf "$wf_id" '.[] | select(.id==$wf) | .generation'
}

GEN_BEFORE="$(generation_for_workflow "$WF_ID")"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-213.XXXXXX")"
trap 'rm -rf "$TMP_DIR" "$CFG_FILE"; invoker_e2e_cleanup' EXIT

echo "==> case 2.13: race reset intents (rebase + recreate x4)"
(
  set +e
  invoker_e2e_run_headless rebase "$TASK_ID" >"$TMP_DIR/rebase.out" 2>&1
  echo $? >"$TMP_DIR/rebase.code"
) &
for i in 1 2 3 4; do
  (
    set +e
    invoker_e2e_run_headless recreate "$WF_ID" >"$TMP_DIR/recreate-$i.out" 2>&1
    echo $? >"$TMP_DIR/recreate-$i.code"
  ) &
done
wait

GEN_AFTER="$(generation_for_workflow "$WF_ID")"
DELTA=$((GEN_AFTER - GEN_BEFORE))

if [ "$DELTA" -lt 1 ]; then
  echo "FAIL case 2.13: expected generation to increase, got delta=$DELTA (before=$GEN_BEFORE after=$GEN_AFTER)"
  echo "--- rebase output ---"
  sed -n '1,80p' "$TMP_DIR/rebase.out" || true
  for i in 1 2 3 4; do
    echo "--- recreate $i output ---"
    sed -n '1,40p' "$TMP_DIR/recreate-$i.out" || true
  done
  invoker_e2e_run_headless status 2>&1 || true
  exit 1
fi

if ! invoker_e2e_run_headless query workflows --output label >/dev/null; then
  echo "FAIL case 2.13: headless workflow query failed after concurrent reset intents"
  exit 1
fi

echo "PASS case 2.13 (real submission + concurrent rebase/recreate reset intents executed)"
