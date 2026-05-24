#!/usr/bin/env bash
# Focused unit-style test for scripts/prod-recreate-supervisor.sh.
#
# Verifies:
#   1. Static: the script contains the upstream fetch and update-ref calls and
#      the expected recreate enqueue command shape; it does NOT contain
#      `git checkout`, `git reset --hard`, or any reference to repo-pool
#      mirrors.
#   2. Behavioral: running the script against a sandbox repo with a stale
#      refs/heads/master and a bare upstream advances refs/heads/master to the
#      upstream SHA while leaving the checked-out branch and HEAD unchanged,
#      and queues `recreate` for failed workflows via the expected command
#      shape.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "FAIL: missing $SCRIPT"
  exit 1
fi

# ---------------------------------------------------------------------------
# Static checks
# ---------------------------------------------------------------------------

require_contains() {
  local pattern="$1"
  if ! grep -Eq "$pattern" "$SCRIPT"; then
    echo "FAIL: prod-recreate-supervisor.sh missing required pattern: $pattern"
    exit 1
  fi
}

# Reject the pattern unless every match is on a pure-comment line.
reject_contains() {
  local pattern="$1"
  local why="$2"
  local hits
  hits="$(grep -nE "$pattern" "$SCRIPT" | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
  if [[ -n "$hits" ]]; then
    echo "FAIL: prod-recreate-supervisor.sh must NOT contain: $pattern ($why)"
    echo "$hits"
    exit 1
  fi
}

require_contains 'git fetch.*refs/heads/.*:'
require_contains 'git update-ref'
require_contains 'refs/remotes/'
require_contains 'refs/heads/'
require_contains 'INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS'
require_contains 'INVOKER_PROD_SUPERVISOR_MAX_CYCLES'
require_contains 'INVOKER_PROD_SUPERVISOR_STALL_CYCLES'
require_contains 'node scripts/headless-ipc\.js exec --no-track -- recreate'

reject_contains 'git[[:space:]]+checkout[[:space:]]' 'must not checkout any branch'
reject_contains 'git[[:space:]]+reset[[:space:]]+--hard' 'must not reset --hard'
reject_contains 'repo-pool' 'must not touch repo-pool mirrors'

echo "PASS: static checks"

# ---------------------------------------------------------------------------
# Behavioral test
# ---------------------------------------------------------------------------

TMP_DIR="$(mktemp -d -t prod-recreate-supervisor-test.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

UPSTREAM_DIR="$TMP_DIR/upstream.git"
WORK_DIR="$TMP_DIR/worktree"
SEED_DIR="$TMP_DIR/seed"

git init --quiet --bare "$UPSTREAM_DIR"

mkdir -p "$SEED_DIR"
(
  cd "$SEED_DIR"
  git init --quiet -b master
  git config user.email "test@example.com"
  git config user.name "Test"
  echo "seed" > README.md
  git add README.md
  git commit --quiet -m "seed"
  git remote add origin "$UPSTREAM_DIR"
  git push --quiet origin master
)
UPSTREAM_SHA="$(git -C "$SEED_DIR" rev-parse HEAD)"

git init --quiet -b feature/sandbox "$WORK_DIR"
(
  cd "$WORK_DIR"
  git config user.email "test@example.com"
  git config user.name "Test"
  echo "feature" > FEATURE.md
  git add FEATURE.md
  git commit --quiet -m "feature commit"
  feature_sha="$(git rev-parse HEAD)"
  # Stale refs/heads/master pointing at the feature commit. The supervisor
  # must move this ref to the upstream SHA via update-ref only.
  git update-ref refs/heads/master "$feature_sha"
  git remote add upstream "$UPSTREAM_DIR"
)

START_BRANCH="$(git -C "$WORK_DIR" symbolic-ref --short HEAD)"
START_HEAD_SHA="$(git -C "$WORK_DIR" rev-parse HEAD)"
STALE_MASTER_SHA="$(git -C "$WORK_DIR" rev-parse refs/heads/master)"

if [[ "$STALE_MASTER_SHA" == "$UPSTREAM_SHA" ]]; then
  echo "FAIL: test setup error — stale master SHA equals upstream SHA"
  exit 1
fi

mkdir -p "$WORK_DIR/scripts"
cp "$SCRIPT" "$WORK_DIR/scripts/prod-recreate-supervisor.sh"
chmod +x "$WORK_DIR/scripts/prod-recreate-supervisor.sh"

# Stub run.sh: returns one failed PR workflow and one completed workflow. The
# failed workflow must be picked up as both `failed` and `incomplete`.
cat > "$WORK_DIR/run.sh" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" != "--headless" ]]; then
  echo "mock run.sh expects --headless" >&2
  exit 1
fi
shift
case "${1:-}" in
  query)
    case "${2:-}" in
      workflows)
        cat <<'JSON'
[
  {"id":"wf-1000-1","status":"failed","onFinish":"pull_request"},
  {"id":"wf-1001-1","status":"completed"}
]
JSON
        ;;
      queue)
        printf '{"running":[],"queued":[],"runningCount":0,"maxConcurrency":4}'
        ;;
      *)
        echo "unsupported query subcommand: ${2:-}" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "unsupported command: ${1:-}" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$WORK_DIR/run.sh"

# Stub headless-ipc.js. Records each invocation's argv joined with spaces so
# the test can assert the exact command shape used by queue_recreate.
RECREATE_LOG="$WORK_DIR/recreate-calls.log"
cat > "$WORK_DIR/scripts/headless-ipc.js" <<EOF
#!/usr/bin/env node
const fs = require("fs");
fs.appendFileSync("$RECREATE_LOG", process.argv.slice(2).join(" ") + "\n");
process.exit(0);
EOF

SUPER_LOG="$WORK_DIR/supervisor.log"
set +e
INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS=1 \
INVOKER_PROD_SUPERVISOR_MAX_CYCLES=1 \
INVOKER_PROD_SUPERVISOR_STALL_CYCLES=99 \
  bash "$WORK_DIR/scripts/prod-recreate-supervisor.sh" "$SUPER_LOG"
EC=$?
set -e

# With MAX_CYCLES=1 and an incomplete workflow, the supervisor exits 124 after
# one cycle. Exit 0 is also acceptable (would mean all workflows completed).
if [[ "$EC" -ne 124 && "$EC" -ne 0 ]]; then
  echo "FAIL: supervisor exited with unexpected status $EC"
  cat "$SUPER_LOG" || true
  exit 1
fi

# Phase 1: ref sync.
ACTUAL_MASTER_SHA="$(git -C "$WORK_DIR" rev-parse refs/heads/master)"
if [[ "$ACTUAL_MASTER_SHA" != "$UPSTREAM_SHA" ]]; then
  echo "FAIL: refs/heads/master was not advanced to upstream/master"
  echo "  expected: $UPSTREAM_SHA"
  echo "  actual:   $ACTUAL_MASTER_SHA"
  echo "  stale:    $STALE_MASTER_SHA"
  cat "$SUPER_LOG" || true
  exit 1
fi

if ! git -C "$WORK_DIR" rev-parse --verify refs/remotes/upstream/master >/dev/null 2>&1; then
  echo "FAIL: refs/remotes/upstream/master was not created by fetch"
  cat "$SUPER_LOG" || true
  exit 1
fi

END_BRANCH="$(git -C "$WORK_DIR" symbolic-ref --short HEAD)"
END_HEAD_SHA="$(git -C "$WORK_DIR" rev-parse HEAD)"
if [[ "$END_BRANCH" != "$START_BRANCH" ]]; then
  echo "FAIL: supervisor changed the checked-out branch ($START_BRANCH -> $END_BRANCH)"
  exit 1
fi
if [[ "$END_HEAD_SHA" != "$START_HEAD_SHA" ]]; then
  echo "FAIL: supervisor moved HEAD off the starting commit ($START_HEAD_SHA -> $END_HEAD_SHA)"
  exit 1
fi

# Phase 2: recreate enqueue shape.
if [[ ! -s "$RECREATE_LOG" ]]; then
  echo "FAIL: supervisor did not call headless-ipc.js for recreate"
  cat "$SUPER_LOG" || true
  exit 1
fi
if ! grep -qx 'exec --no-track -- recreate wf-1000-1' "$RECREATE_LOG"; then
  echo "FAIL: recreate enqueue command shape did not match"
  echo "logged calls:"
  cat "$RECREATE_LOG"
  exit 1
fi
if grep -qE 'recreate wf-1001-1' "$RECREATE_LOG"; then
  echo "FAIL: supervisor enqueued recreate for a completed workflow"
  cat "$RECREATE_LOG"
  exit 1
fi

echo "PASS: prod-recreate-supervisor syncs host master ref via update-ref, preserves branch and HEAD, and enqueues recreate via the expected command shape"
