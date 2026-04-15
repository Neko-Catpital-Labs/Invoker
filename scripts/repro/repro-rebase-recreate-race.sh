#!/usr/bin/env bash
# Reproduce concurrent rebase + recreate intents on the same workflow with real plan submission.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../e2e-dry-run/lib/common.sh"

invoker_e2e_init
cleanup() {
  rm -rf "${TMP_DIR:-}" "${CFG_FILE:-}" 2>/dev/null || true
  invoker_e2e_cleanup
}
trap cleanup EXIT

cd "$INVOKER_E2E_REPO_ROOT"
unset ELECTRON_RUN_AS_NODE
CFG_FILE="$(mktemp "${TMPDIR:-/tmp}/invoker-repro-config.XXXXXX.json")"
printf '{}\n' > "$CFG_FILE"
export INVOKER_REPO_CONFIG_PATH="$CFG_FILE"

echo "==> repro: delete-all"
invoker_e2e_run_headless delete-all

PLAN="$INVOKER_E2E_REPO_ROOT/plans/e2e-dry-run/group2-multi-task/2.13-rebase-recreate-race.yaml"
echo "==> repro: submit plan $PLAN"
invoker_e2e_submit_plan "$PLAN" || true

WF_ID="$(invoker_e2e_run_headless query workflows --output label | grep -E '^wf-[0-9]+-[0-9]+$' | tail -1)"
TASK_ID="$(invoker_e2e_run_headless query tasks --workflow "$WF_ID" --no-merge --output label | grep '/' | head -1)"

echo "workflow: $WF_ID"
echo "task:     $TASK_ID"
if [ -z "${WF_ID:-}" ] || [ -z "${TASK_ID:-}" ]; then
  echo "ERROR: unable to resolve workflow/task"
  exit 1
fi

START_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-race.XXXXXX")"

generation_for_workflow() {
  local wf_id="$1"
  invoker_e2e_run_headless query workflows --output jsonl \
    | grep '^{' \
    | jq -sr --arg wf "$wf_id" '.[] | select(.id==$wf) | .generation'
}
GEN_BEFORE="$(generation_for_workflow "$WF_ID")"

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

END_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
GEN_AFTER="$(generation_for_workflow "$WF_ID")"

echo "window:           $START_UTC .. $END_UTC"
echo "generation before: $GEN_BEFORE"
echo "generation after:  $GEN_AFTER"
echo "generation delta:  $((GEN_AFTER - GEN_BEFORE))"
echo ""

echo "==> command exit codes"
echo "rebase: $(cat "$TMP_DIR/rebase.code" 2>/dev/null || echo missing)"
for i in 1 2 3 4; do
  echo "recreate[$i]: $(cat "$TMP_DIR/recreate-$i.code" 2>/dev/null || echo missing)"
done
echo ""

echo "==> relevant log lines (workflow + reset operations)"
rg -n "$WF_ID|rebaseAndRetry: taskId=$TASK_ID|headless.exec: \\\"rebase $TASK_ID\\\"|bumped generation to [0-9]+ for $WF_ID|bumpGenerationAndRecreate: calling recreateWorkflow\\($WF_ID\\)" \
  ~/.invoker/invoker.log | tail -n 120 || true

echo ""
echo "==> command outputs (first lines)"
echo "--- rebase ---"
sed -n '1,40p' "$TMP_DIR/rebase.out" || true
for i in 1 2 3 4; do
  echo "--- recreate[$i] ---"
  sed -n '1,20p' "$TMP_DIR/recreate-$i.out" || true
done

echo "repro complete"
