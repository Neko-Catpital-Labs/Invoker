#!/usr/bin/env bash
# PR babysitting end-to-end under a live owner, fully offline:
#   merge gate opens against a stub gh -> flip PR to DIRTY -> the pr-status
#   poll publishes review_gate.merge_conflict -> the auto-started
#   review-gate-merge-conflict worker submits invoker:rebase-recreate and the
#   workflow GENERATION ADVANCES -> flip PR to CI-FAILED -> the ci-failure
#   worker records a repair decision (invoker:fix-with-agent intent).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT"

# shellcheck disable=SC1091
source "$ROOT/scripts/e2e-dry-run/lib/common.sh"

export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--max-old-space-size=512"
unset INVOKER_HEADLESS_STANDALONE
unset ELECTRON_RUN_AS_NODE

# Short /tmp base: the owner binds a UNIX socket at $INVOKER_DB_DIR/
# ipc-transport.sock, and macOS truncates sun_path beyond ~104 bytes — a long
# ${TMPDIR}-based HOME silently breaks socket exposure.
TMP="$(mktemp -d /tmp/inv-pbb.XXXXXX)"
export HOME="$TMP/home"
mkdir -p "$HOME/.invoker"
export INVOKER_DB_DIR="$HOME/.invoker"
export INVOKER_REPO_CONFIG_PATH="$TMP/config.json"
printf '{\n  "autoFixRetries": 1\n}\n' > "$INVOKER_REPO_CONFIG_PATH"
export INVOKER_GITHUB_TARGET_REPO="fake/repo"

MARKER_ROOT="$TMP/markers"
mkdir -p "$MARKER_ROOT" "$TMP/bin"
export CHAOS_GH_MARKER_ROOT="$MARKER_ROOT"

# --- Stub gh: PR lifecycle driven by marker files -------------------------
cat > "$TMP/bin/gh" <<'GH'
#!/usr/bin/env bash
# Stub gh for the pr-babysit chaos case. Marker files under
# $CHAOS_GH_MARKER_ROOT flip the PR between CLEAN, DIRTY, and CI-FAILED.
set -eu
M="${CHAOS_GH_MARKER_ROOT:?}"
echo "gh $*" >> "$M/gh-calls.log"
SUBCMD="${1:-}"; shift || true
rollup() {
  local conclusion="$1"
  printf '[{"__typename":"CheckRun","name":"unit","conclusion":"%s","status":"COMPLETED","completedAt":"2026-07-20T00:00:00Z","detailsUrl":"https://github.com/fake/repo/actions/runs/1/job/2"}]' "$conclusion"
}
case "$SUBCMD" in
  pr)
    ACTION="${1:-}"; shift || true
    case "$ACTION" in
      view)
        PR_NUM="${1:-99}"
        MERGE_STATE="CLEAN"; CHECKS="$(rollup SUCCESS)"
        [ -f "$M/pr-ci-failed" ] && CHECKS="$(rollup FAILURE)"
        [ -f "$M/pr-dirty" ] && MERGE_STATE="DIRTY"
        printf '{"state":"OPEN","reviewDecision":null,"url":"https://github.com/fake/repo/pull/%s","headRefOid":"ffffffffffffffffffffffffffffffffffffffff","headRefName":"stack/%s","mergeStateStatus":"%s","statusCheckRollup":%s}\n' "$PR_NUM" "$PR_NUM" "$MERGE_STATE" "$CHECKS"
        ;;
      *) echo "{}" ;;
    esac
    ;;
  api)
    ENDPOINT="${1:-}"; shift || true
    if echo "$ENDPOINT" | grep -qE 'pulls$'; then
      METHOD="GET"; prev=""
      for arg in "$@"; do
        [ "$prev" = "--method" ] && { METHOD="$arg"; break; }
        prev="$arg"
      done
      if [ "$METHOD" = "GET" ]; then echo '[]'; else echo '{"html_url":"https://github.com/fake/repo/pull/99","number":99}'; fi
    else
      echo '{}'
    fi
    ;;
  *) echo "{}" ;;
esac
exit 0
GH
chmod +x "$TMP/bin/gh"
ln -sf "$ROOT/scripts/e2e-dry-run/fixtures/claude-marker.sh" "$TMP/bin/claude"
export INVOKER_CLAUDE_FIX_COMMAND="$TMP/bin/claude"
export PATH="$TMP/bin:$PATH"

# --- Local scratch repo the workflow clones ------------------------------
SCRATCH="$TMP/scratch-repo"
git init -q "$SCRATCH"
git -C "$SCRATCH" -c user.email=e2e@invoker -c user.name=e2e commit -q --allow-empty -m init

OWNER_LOG="$TMP/owner.log"
OWNER_PID=""
cleanup() {
  if [ -n "$OWNER_PID" ]; then
    kill "$OWNER_PID" 2>/dev/null || true
    wait "$OWNER_PID" 2>/dev/null || true
  fi
  # run.sh spawns Electron as a grandchild; kill any owner still bound to this
  # case's temp DB dir so failed runs never leave orphaned GUI owners behind.
  local pid
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    if invoker_e2e_pid_has_env "$pid" "INVOKER_DB_DIR" "$INVOKER_DB_DIR"; then
      kill -9 "$pid" 2>/dev/null || true
    fi
  done < <(pgrep -f 'packages/app/dist/main.js' 2>/dev/null || true)
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

fail() {
  echo "FAIL pr-babysit-conflict: $1"
  echo "----- owner log tail -----"
  tail -n 80 "$OWNER_LOG" 2>/dev/null || true
  echo "----- gh calls tail -----"
  tail -n 20 "$MARKER_ROOT/gh-calls.log" 2>/dev/null || true
  exit 1
}

echo "==> pr-babysit: start owner"
./run.sh >"$OWNER_LOG" 2>&1 &
OWNER_PID=$!

READY=0
for _ in $(seq 1 240); do
  [ -S "$HOME/.invoker/ipc-transport.sock" ] && { READY=1; break; }
  sleep 1
done
[ "$READY" -eq 1 ] || fail "owner never exposed ipc socket"

PLAN_PATH="$TMP/plan.yaml"
cat > "$PLAN_PATH" <<EOF
name: chaos pr babysit conflict
repoUrl: file://$SCRATCH
onFinish: none
mergeMode: external_review
featureBranch: experiment/pr-babysit
baseBranch: HEAD
tasks:
  - id: babysit-task
    description: trivial task feeding the merge gate
    command: echo ok
    dependencies: []
EOF

echo "==> pr-babysit: submit plan"
SUBMIT_LOG="$TMP/submit.log"
./submit-plan.sh "$PLAN_PATH" 2>&1 | tee "$SUBMIT_LOG"
WF_ID="$(grep -oE 'wf-[0-9]+-[0-9]+' "$SUBMIT_LOG" | tail -1 || true)"
[ -n "$WF_ID" ] || fail "could not resolve workflow id from submit output"

echo "==> pr-babysit: wait for merge gate to open (PR created via stub gh)"
MERGE_ID=""
for _ in $(seq 1 120); do
  MERGE_ID="$(invoker_e2e_merge_gate_id || true)"
  if [ -n "$MERGE_ID" ]; then
    STM="$(invoker_e2e_task_status "$MERGE_ID" || true)"
    if [ "$STM" = "review_ready" ] || [ "$STM" = "awaiting_approval" ]; then
      break
    fi
  fi
  sleep 2
done
[ -n "$MERGE_ID" ] || fail "merge gate never appeared"
STM="$(invoker_e2e_task_status "$MERGE_ID" || true)"
{ [ "$STM" = "review_ready" ] || [ "$STM" = "awaiting_approval" ]; } \
  || fail "merge gate never opened (status='$STM')"

workflow_generation() {
  invoker_e2e_run_headless query workflow "$WF_ID" --output json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin).get("generation", 0))' 2>/dev/null || echo 0
}
GEN0="$(workflow_generation)"
echo "==> pr-babysit: baseline generation=$GEN0; flip PR to DIRTY"
touch "$MARKER_ROOT/pr-dirty"

# pr-status polls every 60s; the merge-conflict worker wakes on the event and
# submits invoker:rebase-recreate, which advances the workflow generation.
ADVANCED=0
for _ in $(seq 1 120); do
  GEN_NOW="$(workflow_generation)"
  if [ "${GEN_NOW:-0}" -gt "${GEN0:-0}" ] 2>/dev/null; then
    ADVANCED=1
    break
  fi
  sleep 3
done
[ "$ADVANCED" -eq 1 ] || fail "workflow generation never advanced after merge conflict (still $GEN0)"
echo "==> pr-babysit: generation advanced ($GEN0 -> $GEN_NOW) via rebase-recreate"

rm -f "$MARKER_ROOT/pr-dirty"

echo "==> pr-babysit: wait for the gate to re-open, then flip PR to CI-FAILED"
GATE_REOPENED=0
for _ in $(seq 1 120); do
  MERGE_ID="$(invoker_e2e_merge_gate_id || true)"
  if [ -n "$MERGE_ID" ]; then
    STM="$(invoker_e2e_task_status "$MERGE_ID" || true)"
    if [ "$STM" = "review_ready" ] || [ "$STM" = "awaiting_approval" ]; then
      GATE_REOPENED=1
      break
    fi
  fi
  sleep 2
done
[ "$GATE_REOPENED" -eq 1 ] || fail "merge gate did not reopen after conflict repair"
touch "$MARKER_ROOT/pr-ci-failed"

CI_DECIDED=0
for _ in $(seq 1 120); do
  # worker-actions (not worker-decisions) because its JSON serializes the raw
  # row payload, which carries the submitted intent channel. The owner holds
  # the sqlite DB with locking_mode=EXCLUSIVE, so the intent row itself is
  # unreadable from this process while the owner lives.
  ACTIONS_JSON="$(invoker_e2e_run_headless query worker-actions --workflow "$WF_ID" --output json 2>/dev/null || true)"
  if python3 - "$WF_ID" "$MERGE_ID" "$ACTIONS_JSON" <<'PY'
import json
import sys

workflow_id, task_id, actions_json = sys.argv[1:4]
try:
    actions = json.loads(actions_json)
except json.JSONDecodeError:
    raise SystemExit(1)

if not isinstance(actions, list):
    raise SystemExit(1)

for action in actions:
    if not isinstance(action, dict):
        continue
    # Raw rows carry no decision field; skipped status is the 'skip' decision
    # class, everything else is 'act'.
    if action.get("status") == "skipped":
        continue
    if action.get("workflowId") != workflow_id:
        continue
    if action.get("taskId") != task_id:
        continue
    if action.get("workerKind") != "ci-failure":
        continue
    if action.get("actionType") != "fix-ci-failure":
        continue
    if not action.get("intentId"):
        continue
    payload = action.get("payload")
    if not isinstance(payload, dict):
        continue
    # Require the invoker:fix-with-agent repair channel recorded with the
    # submitted intent, so a no-op or unrelated decision cannot satisfy the
    # scenario.
    if payload.get("channel") == "invoker:fix-with-agent":
        raise SystemExit(0)

raise SystemExit(1)
PY
  then
    CI_DECIDED=1
    break
  fi
  sleep 3
done
[ "$CI_DECIDED" -eq 1 ] || fail "no ci-failure invoker:fix-with-agent repair decision after CI failure"
echo "==> pr-babysit: ci-failure worker recorded an invoker:fix-with-agent repair decision"

# The repair intent is deliberately in flight; let the PR read green again so
# the fix path can finish, then wait for open intents to drain before the
# liveness gate (retrying rides out transient sqlite lock contention too).
rm -f "$MARKER_ROOT/pr-ci-failed"
LIVENESS_OK=0
for _ in $(seq 1 60); do
  if invoker_e2e_assert_liveness_clean 15 30 0 2>/dev/null; then
    LIVENESS_OK=1
    break
  fi
  sleep 5
done
if [ "$LIVENESS_OK" -ne 1 ]; then
  invoker_e2e_assert_liveness_clean 15 30 0 || fail "liveness not clean after repair drain"
fi

echo "PASS pr-babysit-conflict (generation $GEN0 -> $GEN_NOW; ci-failure repair decision present)"
