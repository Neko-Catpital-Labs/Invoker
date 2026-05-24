#!/usr/bin/env bash
# Focused tests for scripts/prod-recreate-supervisor.sh.
#
# Covers:
#   - Static guardrails: the script uses `git fetch upstream
#     refs/heads/master:refs/remotes/upstream/master` + `git update-ref
#     refs/heads/master`, and does NOT use `git checkout master`,
#     `git reset --hard`, or repo-pool mirror mutation.
#   - Behavior: in a sandbox repo with an upstream remote that has advanced
#     past the local clone, running the supervisor moves refs/heads/master to
#     the upstream master SHA while leaving HEAD on the existing branch.
#   - Behavior: when query_workflows reports a failed workflow, the supervisor
#     enqueues a recreate via `headless-ipc.js exec --no-track -- recreate
#     <wf_id>`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "FAIL: missing $SCRIPT"
  exit 1
fi

TMP_DIR="$(mktemp -d -t prod-recreate-supervisor-test.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# ---------------------------------------------------------------------------
# 1. Static guardrails
# ---------------------------------------------------------------------------

assert_contains() {
  local pattern="$1" label="$2"
  if ! grep -qE -- "$pattern" "$SCRIPT"; then
    echo "FAIL: $label — expected $SCRIPT to contain pattern: $pattern"
    exit 1
  fi
}

assert_absent() {
  local pattern="$1" label="$2"
  if grep -qE -- "$pattern" "$SCRIPT"; then
    echo "FAIL: $label — $SCRIPT must not contain pattern: $pattern"
    grep -nE -- "$pattern" "$SCRIPT" || true
    exit 1
  fi
}

assert_contains 'git fetch upstream refs/heads/master:refs/remotes/upstream/master' \
  "upstream master fetch refspec present"
assert_contains 'git rev-parse refs/remotes/upstream/master' \
  "upstream master SHA resolution present"
assert_contains 'git update-ref refs/heads/master' \
  "git update-ref of refs/heads/master present"
assert_contains 'headless-ipc\.js exec --no-track -- recreate' \
  "headless-ipc recreate enqueue present"

assert_absent 'git[[:space:]]+checkout[[:space:]]+master([[:space:]]|$)' \
  "must not checkout master"
assert_absent 'git[[:space:]]+reset[[:space:]]+--hard' \
  "must not reset --hard"
assert_absent 'repo-pool' \
  "must not mutate repo-pool mirrors"

# ---------------------------------------------------------------------------
# 2. Sandbox repo setup
# ---------------------------------------------------------------------------

UPSTREAM_BARE="$TMP_DIR/upstream-bare.git"
LOCAL_REPO="$TMP_DIR/local"
SEED="$TMP_DIR/seed"

git init -q --bare --initial-branch=master "$UPSTREAM_BARE"

git init -q --initial-branch=master "$SEED"
(
  cd "$SEED"
  git config user.email "supervisor-test@example.com"
  git config user.name "Supervisor Test"
  echo old > file.txt
  git add file.txt
  git commit -q -m "seed"
  git push -q "$UPSTREAM_BARE" master
)

# Local clone happens BEFORE upstream advances, so the local master is stale.
git clone -q "$UPSTREAM_BARE" "$LOCAL_REPO"
(
  cd "$LOCAL_REPO"
  git config user.email "supervisor-test@example.com"
  git config user.name "Supervisor Test"
  git remote rename origin upstream
  git checkout -q -b feature/something
)
OLD_MASTER_SHA="$(git -C "$LOCAL_REPO" rev-parse refs/heads/master)"

# Advance upstream master to a NEW SHA.
(
  cd "$SEED"
  echo new > file.txt
  git commit -q -am "advance upstream"
  git push -q "$UPSTREAM_BARE" master
)
NEW_MASTER_SHA="$(git -C "$SEED" rev-parse HEAD)"

if [[ "$OLD_MASTER_SHA" == "$NEW_MASTER_SHA" ]]; then
  echo "FAIL: test setup did not advance upstream master"
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Drop supervisor + mocks into the local repo
# ---------------------------------------------------------------------------

mkdir -p "$LOCAL_REPO/scripts"
cp "$SCRIPT" "$LOCAL_REPO/scripts/prod-recreate-supervisor.sh"
chmod +x "$LOCAL_REPO/scripts/prod-recreate-supervisor.sh"

STATE_DIR="$TMP_DIR/state"
mkdir -p "$STATE_DIR"
RECREATE_LOG="$STATE_DIR/recreate.log"
WF_CALL_LOG="$STATE_DIR/workflows-calls"
: > "$RECREATE_LOG"
: > "$WF_CALL_LOG"

# Mock run.sh: cycle 1 returns one failed workflow, cycle 2+ returns it
# completed so the supervisor exits cleanly.
cat > "$LOCAL_REPO/run.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" != "--headless" ]]; then
  echo "mock run.sh expects --headless" >&2
  exit 1
fi
shift
cmd="\${1:-}"
shift || true
sub="\${1:-}"
case "\$cmd \$sub" in
  "query workflows")
    printf 'wf\n' >> "$WF_CALL_LOG"
    calls=\$(wc -l < "$WF_CALL_LOG" | tr -d ' ')
    if [[ "\$calls" -le 1 ]]; then
      printf '[{"id":"wf-1-1","status":"failed","onFinish":"local"}]\n'
    else
      printf '[{"id":"wf-1-1","status":"completed","onFinish":"local"}]\n'
    fi
    ;;
  "query queue")
    printf '{"running":[],"queued":[],"runningCount":0,"maxConcurrency":0}\n'
    ;;
  *)
    echo "unsupported mock command: \$cmd \$sub" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$LOCAL_REPO/run.sh"

# Mock headless-ipc.js: log invocations and succeed.
cat > "$LOCAL_REPO/scripts/headless-ipc.js" <<EOF
#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync("$RECREATE_LOG", process.argv.slice(2).join(' ') + '\n');
process.exit(0);
EOF
chmod +x "$LOCAL_REPO/scripts/headless-ipc.js"

# ---------------------------------------------------------------------------
# 4. Run supervisor (short interval, bounded cycles)
# ---------------------------------------------------------------------------

SUP_LOG="$TMP_DIR/supervisor.log"
set +e
INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS=1 \
INVOKER_PROD_SUPERVISOR_MAX_CYCLES=4 \
INVOKER_PROD_SUPERVISOR_STALL_CYCLES=99 \
bash "$LOCAL_REPO/scripts/prod-recreate-supervisor.sh" "$SUP_LOG"
EC=$?
set -e

if [[ "$EC" -ne 0 ]]; then
  echo "FAIL: supervisor exited with $EC; expected clean exit (0)"
  echo "--- supervisor log ---"
  cat "$SUP_LOG" || true
  exit 1
fi

# ---------------------------------------------------------------------------
# 5. refs/heads/master must point at upstream master; HEAD must be untouched
# ---------------------------------------------------------------------------

ACTUAL_MASTER="$(git -C "$LOCAL_REPO" rev-parse refs/heads/master)"
if [[ "$ACTUAL_MASTER" != "$NEW_MASTER_SHA" ]]; then
  echo "FAIL: refs/heads/master was not advanced to upstream master"
  echo "  expected: $NEW_MASTER_SHA"
  echo "  actual:   $ACTUAL_MASTER"
  echo "--- supervisor log ---"
  cat "$SUP_LOG" || true
  exit 1
fi

CURRENT_BRANCH="$(git -C "$LOCAL_REPO" symbolic-ref --short HEAD)"
if [[ "$CURRENT_BRANCH" != "feature/something" ]]; then
  echo "FAIL: HEAD moved off feature/something to '$CURRENT_BRANCH'"
  exit 1
fi

# Working tree must remain at the old master file (no reset/checkout happened).
if [[ "$(cat "$LOCAL_REPO/file.txt")" != "old" ]]; then
  echo "FAIL: working tree was mutated; supervisor must not checkout/reset"
  exit 1
fi

# ---------------------------------------------------------------------------
# 6. Recreate enqueue command shape
# ---------------------------------------------------------------------------

if ! grep -qx 'exec --no-track -- recreate wf-1-1' "$RECREATE_LOG"; then
  echo "FAIL: expected recreate enqueue line 'exec --no-track -- recreate wf-1-1'"
  echo "--- recreate.log ---"
  cat "$RECREATE_LOG" || true
  exit 1
fi

# Sanity: the failed wf was enqueued exactly once (not the stall path).
COUNT="$(grep -c 'recreate wf-1-1' "$RECREATE_LOG" || true)"
if [[ "$COUNT" != "1" ]]; then
  echo "FAIL: expected exactly 1 recreate enqueue for wf-1-1, got $COUNT"
  cat "$RECREATE_LOG" || true
  exit 1
fi

echo "PASS: prod-recreate-supervisor.sh — host master ref sync + recreate enqueue shape verified"
