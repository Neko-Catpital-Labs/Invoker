#!/usr/bin/env bash
# Focused test for scripts/prod-recreate-supervisor.sh.
#
# Verifies three contracts:
#   1. Static: the script contains the upstream master fetch and the
#      `git update-ref refs/heads/master` invocation, and DOES NOT use
#      `git checkout master` or `git reset --hard`.
#   2. Runtime: a single `--once` cycle in a sandbox repo advances
#      refs/heads/master to the upstream/master tip via update-ref, without
#      moving HEAD or switching branches.
#   3. Runtime: the cycle dispatches one `recreate <wf_id>` headless mutation
#      per failed workflow, and none for completed workflows.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"
LIB="$ROOT/scripts/headless-lib.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "FAIL: missing $SCRIPT" >&2
  exit 1
fi
if [[ ! -f "$LIB" ]]; then
  echo "FAIL: missing $LIB" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Static checks
# ---------------------------------------------------------------------------

require_pattern() {
  local pattern="$1"
  local label="$2"
  if ! grep -qE "$pattern" "$SCRIPT"; then
    echo "FAIL: script missing $label (pattern: $pattern)" >&2
    exit 1
  fi
}

reject_pattern() {
  local pattern="$1"
  local label="$2"
  if grep -nE "$pattern" "$SCRIPT" >/dev/null; then
    echo "FAIL: script contains forbidden $label:" >&2
    grep -nE "$pattern" "$SCRIPT" >&2
    exit 1
  fi
}

# Upstream fetch into a remote tracking ref.
require_pattern \
  'git fetch[^|;&]*refs/heads/master:refs/remotes/[^[:space:]]+/master' \
  'upstream fetch of refs/heads/master'

# Ref-only update of local master.
require_pattern \
  'git update-ref refs/heads/master' \
  'git update-ref refs/heads/master'

# Recreate command shape — must dispatch via the headless recreate mutation.
require_pattern \
  'recreate' \
  'recreate command'
require_pattern \
  'headless_mutation .*recreate' \
  'headless_mutation recreate invocation'

# Env knobs required by the spec.
require_pattern 'SUPERVISOR_INTERVAL_SECONDS' 'interval env knob'
require_pattern 'SUPERVISOR_MAX_CYCLES'       'max-cycles env knob'
require_pattern 'SUPERVISOR_STALL_CYCLES'     'stall-cycles env knob'

# Forbidden patterns: must not check out master or hard-reset the branch.
reject_pattern 'git[[:space:]]+checkout[[:space:]]+master\b'       'git checkout master'
reject_pattern 'git[[:space:]]+switch[[:space:]]+master\b'         'git switch master'
reject_pattern 'git[[:space:]]+reset[[:space:]]+--hard'            'git reset --hard'

echo "static checks PASS"

# ---------------------------------------------------------------------------
# Runtime check
# ---------------------------------------------------------------------------

TMP_DIR="$(mktemp -d -t prod-recreate-supervisor-test.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

UPSTREAM_REPO="$TMP_DIR/upstream.git"
WORK_REPO="$TMP_DIR/work"
RECREATE_LOG="$TMP_DIR/recreate.log"

git -c init.defaultBranch=master init --bare "$UPSTREAM_REPO" >/dev/null

git -c init.defaultBranch=master init "$WORK_REPO" >/dev/null
(
  cd "$WORK_REPO"
  git config user.email test@invoker.local
  git config user.name test-supervisor
  echo seed > README
  git add README
  git commit -q -m seed
  git remote add upstream "$UPSTREAM_REPO"
  git push -q upstream master
)
SEED_SHA="$(git -C "$WORK_REPO" rev-parse HEAD)"

# Push a second upstream commit on a side branch so that local master stays
# behind. The supervisor's --once cycle must fast-forward master via
# update-ref WITHOUT switching branches.
(
  cd "$WORK_REPO"
  git checkout -q -b upstream-staging
  echo updated > NEW_FILE
  git add NEW_FILE
  git commit -q -m updated
  git push -q upstream upstream-staging:master
)
EXPECTED_SHA="$(git -C "$WORK_REPO" rev-parse upstream-staging)"

# Reset local working tree so we are NOT on master, master is still at SEED,
# and there is no upstream tracking ref yet.
(
  cd "$WORK_REPO"
  git checkout -q -b other "$SEED_SHA"
  git branch -D upstream-staging >/dev/null
  git update-ref refs/heads/master "$SEED_SHA"
  git update-ref -d refs/remotes/upstream/master 2>/dev/null || true
)

LOCAL_MASTER_BEFORE="$(git -C "$WORK_REPO" rev-parse refs/heads/master)"
LOCAL_HEAD_BEFORE="$(git -C "$WORK_REPO" rev-parse HEAD)"
CURRENT_BRANCH_BEFORE="$(git -C "$WORK_REPO" rev-parse --abbrev-ref HEAD)"

[[ "$LOCAL_MASTER_BEFORE" = "$SEED_SHA" ]] || {
  echo "FAIL: test setup: master should be at SEED_SHA, got $LOCAL_MASTER_BEFORE" >&2
  exit 1
}
[[ "$CURRENT_BRANCH_BEFORE" = "other" ]] || {
  echo "FAIL: test setup: current branch should be 'other', got $CURRENT_BRANCH_BEFORE" >&2
  exit 1
}

# Mock layout that satisfies headless-lib.sh's REPO_ROOT/RUNNER assumptions.
MOCK_DIR="$TMP_DIR/mock"
mkdir -p "$MOCK_DIR/scripts"
cp "$SCRIPT" "$MOCK_DIR/scripts/prod-recreate-supervisor.sh"
cp "$LIB"    "$MOCK_DIR/scripts/headless-lib.sh"
chmod +x "$MOCK_DIR/scripts/prod-recreate-supervisor.sh"

cat > "$MOCK_DIR/run.sh" <<EOF
#!/usr/bin/env bash
# Mock headless runner: serves a fixed workflow list and records recreate
# mutations to a log file.
set -euo pipefail
[[ "\${1:-}" = "--headless" ]] || { echo "expected --headless, got \${1:-}" >&2; exit 64; }
shift
case "\${1:-}" in
  query)
    [[ "\${2:-}" = "workflows" ]] || { echo "unsupported query: \${2:-}" >&2; exit 1; }
    cat <<'JSON'
[
  {"id":"wf-1-1","status":"failed"},
  {"id":"wf-2-1","status":"running"},
  {"id":"wf-3-1","status":"completed"},
  {"id":"wf-4-1","status":"failed"}
]
JSON
    exit 0
    ;;
  --no-track)
    shift
    case "\${1:-}" in
      recreate)
        printf 'recreate %s\n' "\${2:-MISSING}" >> "$RECREATE_LOG"
        exit 0
        ;;
      *) echo "unsupported mutation: \${1:-}" >&2; exit 1 ;;
    esac
    ;;
  recreate)
    printf 'recreate %s\n' "\${2:-MISSING}" >> "$RECREATE_LOG"
    exit 0
    ;;
  *) echo "unsupported cmd: \${1:-}" >&2; exit 1 ;;
esac
EOF
chmod +x "$MOCK_DIR/run.sh"

# Stub IPC helper so headless_mutation in non-standalone mode would also fail
# loudly. We pin standalone mode below.
cat > "$MOCK_DIR/scripts/headless-ipc.js" <<'JS'
process.stderr.write("mock headless-ipc should not be reached (standalone mode expected)\n");
process.exit(99);
JS

# Force standalone mode so headless_mutation routes through "$RUNNER --headless".
export INVOKER_HEADLESS_STANDALONE=1

# Run the supervisor inside the work repo so git operations apply there.
(
  cd "$WORK_REPO"
  bash "$MOCK_DIR/scripts/prod-recreate-supervisor.sh" \
    --once \
    --upstream-remote upstream \
    --interval 1 \
    --stall-cycles 999
)

LOCAL_MASTER_AFTER="$(git -C "$WORK_REPO" rev-parse refs/heads/master)"
LOCAL_HEAD_AFTER="$(git -C "$WORK_REPO" rev-parse HEAD)"
CURRENT_BRANCH_AFTER="$(git -C "$WORK_REPO" rev-parse --abbrev-ref HEAD)"

# Phase-1 assertions.
if [[ "$LOCAL_MASTER_AFTER" != "$EXPECTED_SHA" ]]; then
  echo "FAIL: refs/heads/master not advanced to upstream tip" >&2
  echo "       expected $EXPECTED_SHA" >&2
  echo "       got      $LOCAL_MASTER_AFTER" >&2
  exit 1
fi
if [[ "$LOCAL_MASTER_BEFORE" = "$LOCAL_MASTER_AFTER" ]]; then
  echo "FAIL: refs/heads/master did not change (still $LOCAL_MASTER_AFTER)" >&2
  exit 1
fi
if [[ "$LOCAL_HEAD_BEFORE" != "$LOCAL_HEAD_AFTER" ]]; then
  echo "FAIL: HEAD moved during phase 1 (was $LOCAL_HEAD_BEFORE, now $LOCAL_HEAD_AFTER); supervisor must not checkout/reset" >&2
  exit 1
fi
if [[ "$CURRENT_BRANCH_BEFORE" != "$CURRENT_BRANCH_AFTER" ]]; then
  echo "FAIL: current branch changed (was $CURRENT_BRANCH_BEFORE, now $CURRENT_BRANCH_AFTER); supervisor must not checkout master" >&2
  exit 1
fi

# Recreate enqueue assertions.
if [[ ! -s "$RECREATE_LOG" ]]; then
  echo "FAIL: no recreate calls recorded in $RECREATE_LOG" >&2
  exit 1
fi

CALL_COUNT="$(wc -l < "$RECREATE_LOG" | tr -d ' ')"
if [[ "$CALL_COUNT" != "2" ]]; then
  echo "FAIL: expected 2 recreate calls (one per failed workflow), got $CALL_COUNT:" >&2
  cat "$RECREATE_LOG" >&2
  exit 1
fi

grep -qxF 'recreate wf-1-1' "$RECREATE_LOG" || {
  echo "FAIL: recreate not invoked for failed wf-1-1; log:" >&2
  cat "$RECREATE_LOG" >&2
  exit 1
}
grep -qxF 'recreate wf-4-1' "$RECREATE_LOG" || {
  echo "FAIL: recreate not invoked for failed wf-4-1; log:" >&2
  cat "$RECREATE_LOG" >&2
  exit 1
}
if grep -qxF 'recreate wf-3-1' "$RECREATE_LOG"; then
  echo "FAIL: recreate invoked for completed wf-3-1; log:" >&2
  cat "$RECREATE_LOG" >&2
  exit 1
fi
if grep -qxF 'recreate wf-2-1' "$RECREATE_LOG"; then
  echo "FAIL: recreate invoked for running wf-2-1 (stall threshold not yet hit); log:" >&2
  cat "$RECREATE_LOG" >&2
  exit 1
fi

echo "PASS: prod-recreate-supervisor.sh fast-forwards master via update-ref, never checks out / hard-resets, and dispatches recreate per failed workflow"
