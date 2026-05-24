#!/usr/bin/env bash
# Required regression for scripts/prod-recreate-supervisor.sh.
#
# Proves four things, in order:
#   1. The script contains the host-master ref sync (fetch + update-ref).
#   2. The script does NOT contain checkout/reset-hard/repo-pool mutation.
#   3. Exercising --sync-master-only against a sandbox upstream actually moves
#      the local refs/heads/master forward and leaves the worktree HEAD alone.
#   4. The recreate enqueue command shape matches the prod-shaped invocation
#      (headless-ipc.js exec --no-track -- recreate <wf-id>).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"

if [[ ! -x "$SCRIPT" ]]; then
  echo "FAIL: $SCRIPT missing or not executable"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Static checks: the master-sync phase is wired exactly as specified.
# ---------------------------------------------------------------------------

require_pattern() {
  local desc="$1"; local pattern="$2"
  if ! grep -qE "$pattern" "$SCRIPT"; then
    echo "FAIL: supervisor missing required pattern ($desc): $pattern"
    exit 1
  fi
}

reject_pattern() {
  local desc="$1"; local pattern="$2"
  # Strip whole-line comments and trailing comments before scanning so the
  # forbidden phrases (which appear in the script's own documentation) are
  # only rejected when they appear in executable code.
  local stripped
  stripped="$(sed -E 's/[[:space:]]*#.*$//' "$SCRIPT" | grep -v '^[[:space:]]*$' || true)"
  if printf '%s\n' "$stripped" | grep -nE "$pattern"; then
    echo "FAIL: supervisor must not contain $desc ($pattern)"
    exit 1
  fi
}

require_pattern "upstream fetch into remote-tracking ref" \
  'git fetch[^\n]*refs/heads/master:refs/remotes/[^[:space:]"]*master'
require_pattern "rev-parse of remote-tracking master" \
  'git rev-parse[^\n]*refs/remotes/[^[:space:]"]*master'
require_pattern "git update-ref of local master" \
  'git update-ref[[:space:]]+refs/heads/master'

# ---------------------------------------------------------------------------
# 2. Static checks: forbidden mutations are absent.
# ---------------------------------------------------------------------------

reject_pattern "git checkout master"     'git[[:space:]]+checkout[[:space:]]+master'
reject_pattern "any git checkout"        'git[[:space:]]+checkout([[:space:]]|$)'
reject_pattern "git reset --hard"        'git[[:space:]]+reset[[:space:]]+--hard'
reject_pattern "repo-pool mirror update" '(repo-pool|repo_pool)[^\n]*(update|mutate|reset|recreate)'

# ---------------------------------------------------------------------------
# 3. Behavior: --sync-master-only moves local master to upstream master and
#    leaves the current worktree HEAD untouched.
# ---------------------------------------------------------------------------

WORK="$(mktemp -d -t prod-recreate-supervisor-test.XXXXXX)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

UPSTREAM_DIR="$WORK/upstream.git"
LOCAL_DIR="$WORK/local"

git init --quiet --bare "$UPSTREAM_DIR"
git -C "$UPSTREAM_DIR" symbolic-ref HEAD refs/heads/master

SEED_DIR="$WORK/seed"
git init --quiet -b master "$SEED_DIR"
git -C "$SEED_DIR" -c user.email=t@t -c user.name=t commit --quiet --allow-empty -m one
git -C "$SEED_DIR" remote add origin "$UPSTREAM_DIR"
git -C "$SEED_DIR" push --quiet origin master >/dev/null 2>&1

# Local clone, then advance upstream by one commit so master ref sync has work to do.
git clone --quiet "$UPSTREAM_DIR" "$LOCAL_DIR"
git -C "$LOCAL_DIR" remote rename origin upstream
git -C "$LOCAL_DIR" -c user.email=t@t -c user.name=t checkout --quiet -b feature
FEATURE_HEAD="$(git -C "$LOCAL_DIR" rev-parse HEAD)"

git -C "$SEED_DIR" -c user.email=t@t -c user.name=t commit --quiet --allow-empty -m two
git -C "$SEED_DIR" push --quiet origin master >/dev/null 2>&1
NEW_UPSTREAM_SHA="$(git -C "$SEED_DIR" rev-parse refs/heads/master)"

OLD_LOCAL_MASTER="$(git -C "$LOCAL_DIR" rev-parse refs/heads/master)"
if [[ "$OLD_LOCAL_MASTER" == "$NEW_UPSTREAM_SHA" ]]; then
  echo "FAIL: test fixture broken — local master already at upstream tip"
  exit 1
fi

# Stage scripts/ inside the sandbox repo (the script resolves REPO_ROOT
# relative to its own location, then `cd`s there).
mkdir -p "$LOCAL_DIR/scripts"
cp "$SCRIPT" "$LOCAL_DIR/scripts/prod-recreate-supervisor.sh"
chmod +x "$LOCAL_DIR/scripts/prod-recreate-supervisor.sh"

LOG_FILE="$WORK/supervisor.log"
"$LOCAL_DIR/scripts/prod-recreate-supervisor.sh" --sync-master-only "$LOG_FILE"

NEW_LOCAL_MASTER="$(git -C "$LOCAL_DIR" rev-parse refs/heads/master)"
if [[ "$NEW_LOCAL_MASTER" != "$NEW_UPSTREAM_SHA" ]]; then
  echo "FAIL: refs/heads/master not advanced to upstream tip"
  echo "  expected: $NEW_UPSTREAM_SHA"
  echo "  actual:   $NEW_LOCAL_MASTER"
  cat "$LOG_FILE" || true
  exit 1
fi

CURRENT_HEAD="$(git -C "$LOCAL_DIR" rev-parse HEAD)"
if [[ "$CURRENT_HEAD" != "$FEATURE_HEAD" ]]; then
  echo "FAIL: supervisor moved current branch HEAD"
  echo "  feature HEAD before: $FEATURE_HEAD"
  echo "  HEAD after sync:     $CURRENT_HEAD"
  exit 1
fi

CURRENT_BRANCH="$(git -C "$LOCAL_DIR" symbolic-ref --short HEAD)"
if [[ "$CURRENT_BRANCH" != "feature" ]]; then
  echo "FAIL: supervisor switched current branch (now $CURRENT_BRANCH)"
  exit 1
fi

# ---------------------------------------------------------------------------
# 4. Recreate enqueue command shape — verify the exact prod-shaped invocation
#    AND that it actually fires per-failed-workflow with the right arg shape.
# ---------------------------------------------------------------------------

require_pattern "headless-ipc recreate command shape" \
  'node[[:space:]]+scripts/headless-ipc\.js[[:space:]]+exec[[:space:]]+--no-track[[:space:]]+--[[:space:]]+recreate'

CAPTURE="$WORK/recreate-invocations.txt"
: > "$CAPTURE"
MOCK_RECREATE="$WORK/mock-recreate.sh"
cat > "$MOCK_RECREATE" <<'EOF'
#!/usr/bin/env bash
printf 'recreate-call:'
for arg in "$@"; do printf ' %s' "$arg"; done
printf '\n'
EOF
chmod +x "$MOCK_RECREATE"

# Single fast cycle with one failed and one running workflow; mocks stand in
# for the headless query and recreate commands so we can prove the supervisor
# emits exactly one recreate call (for the failed workflow) with the wf id as
# the trailing arg.
WORKFLOWS_JSON='[{"id":"wf-1","status":"failed","onFinish":"pull_request"},{"id":"wf-2","status":"running","onFinish":"pull_request"}]'
QUEUE_JSON='{"running":[],"queued":[],"runningCount":0,"maxConcurrency":0}'

LOG_FILE_2="$WORK/loop.log"
set +e
INVOKER_PROD_SUPERVISOR_SKIP_MASTER_SYNC=1 \
INVOKER_PROD_SUPERVISOR_MAX_CYCLES=1 \
INVOKER_PROD_SUPERVISOR_STALL_CYCLES=9999 \
INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS=0 \
INVOKER_PROD_SUPERVISOR_SLEEP_CMD=true \
INVOKER_PROD_SUPERVISOR_QUERY_WORKFLOWS_CMD="printf '%s' '$WORKFLOWS_JSON'" \
INVOKER_PROD_SUPERVISOR_QUERY_QUEUE_CMD="printf '%s' '$QUEUE_JSON'" \
INVOKER_PROD_SUPERVISOR_RECREATE_CMD="$MOCK_RECREATE >> '$CAPTURE' 2>&1" \
"$LOCAL_DIR/scripts/prod-recreate-supervisor.sh" "$LOG_FILE_2"
LOOP_RC=$?
set -e

if [[ "$LOOP_RC" -ne 124 ]]; then
  echo "FAIL: supervisor expected to exit 124 after max cycles (got $LOOP_RC)"
  cat "$LOG_FILE_2" || true
  exit 1
fi

CALL_COUNT="$(grep -c '^recreate-call:' "$CAPTURE" || true)"
if [[ "$CALL_COUNT" -ne 1 ]]; then
  echo "FAIL: expected exactly 1 recreate enqueue call, got $CALL_COUNT"
  cat "$CAPTURE" || true
  exit 1
fi

if ! grep -qE '^recreate-call:[[:space:]]+wf-1$' "$CAPTURE"; then
  echo "FAIL: recreate enqueue did not receive 'wf-1' as the sole trailing arg"
  cat "$CAPTURE"
  exit 1
fi

if grep -q 'wf-2' "$CAPTURE"; then
  echo "FAIL: recreate enqueued for a non-failed workflow"
  cat "$CAPTURE"
  exit 1
fi

echo "PASS: prod-recreate-supervisor host-sync + enqueue shape verified"
