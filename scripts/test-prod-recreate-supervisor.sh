#!/usr/bin/env bash
# Focused test for scripts/prod-recreate-supervisor.sh.
#
# Verifies:
#   1. The script source uses `git fetch upstream ...` and `git update-ref
#      refs/heads/master` for phase 1 (host master ref sync).
#   2. The script never invokes `git checkout master` or `git reset --hard` —
#      the supervisor is a host-side ref updater, not a branch mover.
#   3. The script enqueues `recreate <workflowId>` for failed workflows with
#      the expected headless command shape.
#   4. Behaviorally: running the supervisor with a sandbox repo + mocked
#      runner moves refs/heads/master to upstream's master SHA, leaves the
#      currently-checked-out branch untouched, and invokes the runner with
#      `--headless --no-track recreate <id>` for the failed workflow.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUPERVISOR="$ROOT/scripts/prod-recreate-supervisor.sh"
HEADLESS_LIB="$ROOT/scripts/headless-lib.sh"

[[ -f "$SUPERVISOR" ]] || { echo "FAIL: missing $SUPERVISOR"; exit 1; }
[[ -f "$HEADLESS_LIB" ]] || { echo "FAIL: missing $HEADLESS_LIB"; exit 1; }

# ---------------------------------------------------------------------------
# 1. Static contract: phase 1 fetch + update-ref must appear in the source.
# ---------------------------------------------------------------------------
SCRIPT_BLOB="$(tr '\n' ' ' < "$SUPERVISOR")"
case "$SCRIPT_BLOB" in
  *'fetch "$UPSTREAM_REMOTE"'*'"refs/heads/${UPSTREAM_BRANCH}:refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"'*) ;;
  *)
    echo "FAIL: supervisor must run 'git fetch upstream refs/heads/master:refs/remotes/upstream/master'"
    exit 1
    ;;
esac
case "$SCRIPT_BLOB" in
  *'update-ref "refs/heads/${UPSTREAM_BRANCH}"'*) ;;
  *)
    echo "FAIL: supervisor must call 'git update-ref refs/heads/master <sha>'"
    exit 1
    ;;
esac
case "$SCRIPT_BLOB" in
  *'rev-parse "refs/remotes/${UPSTREAM_REMOTE}/${UPSTREAM_BRANCH}"'*) ;;
  *)
    echo "FAIL: supervisor must resolve refs/remotes/upstream/master via rev-parse"
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# 2. Static contract: no checkout master / reset --hard / repo-pool writes.
# ---------------------------------------------------------------------------
NORMALIZED="$(grep -vE '^[[:space:]]*#' "$SUPERVISOR")"
if printf '%s\n' "$NORMALIZED" | grep -Eq 'git[[:space:]]+(-C[[:space:]]+[^ ]+[[:space:]]+)?checkout([[:space:]]+|$)'; then
  echo "FAIL: supervisor must not call 'git checkout' — phase 1 is ref-only"
  exit 1
fi
if printf '%s\n' "$NORMALIZED" | grep -Eq 'reset[[:space:]]+--hard'; then
  echo "FAIL: supervisor must not call 'git reset --hard'"
  exit 1
fi
if printf '%s\n' "$NORMALIZED" | grep -Eq 'repo-pool|repoPool|REPO_POOL'; then
  echo "FAIL: supervisor must not touch repo-pool mirrors"
  exit 1
fi

# ---------------------------------------------------------------------------
# 3. Static contract: recreate command shape must use the headless mutation
#    helper with the literal `recreate` verb and a workflow id argument.
# ---------------------------------------------------------------------------
case "$SCRIPT_BLOB" in
  *'headless_mutation --no-track recreate "$wf_id"'*) ;;
  *)
    echo "FAIL: supervisor must enqueue 'recreate <wf_id>' through headless_mutation"
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# 4. Behavioral test: phase 1 ref sync + failed-workflow recreate enqueue.
# ---------------------------------------------------------------------------
TMP_DIR="$(mktemp -d -t prod-recreate-supervisor.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Lay out a fake repo root that mirrors the real layout: scripts/ holds the
# supervisor and headless-lib, run.sh sits next to it. REPO_ROOT inside the
# supervisor resolves to $TMP_DIR by way of headless-lib's BASH_SOURCE walk.
mkdir -p "$TMP_DIR/scripts"
cp "$SUPERVISOR" "$TMP_DIR/scripts/prod-recreate-supervisor.sh"
cp "$HEADLESS_LIB" "$TMP_DIR/scripts/headless-lib.sh"
chmod +x "$TMP_DIR/scripts/prod-recreate-supervisor.sh"

CALL_LOG="$TMP_DIR/runner-calls.log"
: > "$CALL_LOG"

cat > "$TMP_DIR/run.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "\$*" >> "$CALL_LOG"
# Supervisor only ever invokes mutations through this stub once standalone
# mode is on, so a success exit is all that's required.
exit 0
EOF
chmod +x "$TMP_DIR/run.sh"

# Build the sandbox git repo: a local working repo with an `upstream` remote
# whose master is at a different commit from the local refs/heads/master.
UPSTREAM_BARE="$TMP_DIR/upstream.git"
WORK_REPO="$TMP_DIR/work"

git init --bare "$UPSTREAM_BARE" >/dev/null
git -c init.defaultBranch=master init "$WORK_REPO" >/dev/null
git -C "$WORK_REPO" config user.email "test@example.com"
git -C "$WORK_REPO" config user.name "supervisor-test"
echo "seed" > "$WORK_REPO/README.md"
git -C "$WORK_REPO" add README.md
git -C "$WORK_REPO" commit -m "seed" >/dev/null
git -C "$WORK_REPO" branch -M master >/dev/null 2>&1 || true
git -C "$WORK_REPO" remote add upstream "$UPSTREAM_BARE"
git -C "$WORK_REPO" push upstream master >/dev/null

LOCAL_MASTER_BEFORE="$(git -C "$WORK_REPO" rev-parse refs/heads/master)"

# Advance upstream master by a second commit that the local clone has not yet
# pulled. The supervisor's phase 1 should move refs/heads/master forward to
# this new SHA without checking out master.
UPSTREAM_CLONE="$TMP_DIR/upstream-clone"
git clone "$UPSTREAM_BARE" "$UPSTREAM_CLONE" >/dev/null 2>&1
git -C "$UPSTREAM_CLONE" config user.email "test@example.com"
git -C "$UPSTREAM_CLONE" config user.name "upstream-pusher"
echo "second" >> "$UPSTREAM_CLONE/README.md"
git -C "$UPSTREAM_CLONE" commit -am "second" >/dev/null
git -C "$UPSTREAM_CLONE" push origin master >/dev/null
UPSTREAM_MASTER_TARGET="$(git -C "$UPSTREAM_CLONE" rev-parse refs/heads/master)"

if [[ "$LOCAL_MASTER_BEFORE" == "$UPSTREAM_MASTER_TARGET" ]]; then
  echo "FAIL: fixture invariant — local and upstream master must start divergent"
  exit 1
fi

# Detach onto a worker branch so we can prove the supervisor never moves HEAD
# back to master.
git -C "$WORK_REPO" checkout -b worker >/dev/null 2>&1
HEAD_BRANCH_BEFORE="$(git -C "$WORK_REPO" rev-parse --abbrev-ref HEAD)"

# Workflow fixture: one failed workflow (should be recreated), one running
# workflow (incomplete but not failed — should not trigger a recreate on a
# single cycle because the stall counter has nothing to compare against yet).
WORKFLOWS_JSON="$TMP_DIR/workflows.json"
cat > "$WORKFLOWS_JSON" <<'EOF'
[
  {"id": "wf-1000-1", "status": "failed"},
  {"id": "wf-1001-1", "status": "running"},
  {"id": "wf-1002-1", "status": "completed"}
]
EOF

# Run the supervisor for exactly one cycle.
env -i \
  HOME="$HOME" \
  PATH="$PATH" \
  INVOKER_HEADLESS_STANDALONE=1 \
  INVOKER_SUPERVISOR_INTERVAL_SECONDS=1 \
  INVOKER_SUPERVISOR_MAX_CYCLES=1 \
  INVOKER_SUPERVISOR_STALL_CYCLES=1 \
  INVOKER_SUPERVISOR_UPSTREAM_REMOTE=upstream \
  INVOKER_SUPERVISOR_UPSTREAM_BRANCH=master \
  INVOKER_SUPERVISOR_REPO_DIR="$WORK_REPO" \
  INVOKER_SUPERVISOR_WORKFLOWS_JSON_FILE="$WORKFLOWS_JSON" \
  bash "$TMP_DIR/scripts/prod-recreate-supervisor.sh" \
  > "$TMP_DIR/supervisor.log" 2>&1 || {
    echo "FAIL: supervisor exited non-zero"
    cat "$TMP_DIR/supervisor.log"
    exit 1
  }

# refs/heads/master must now match upstream's master SHA via update-ref.
LOCAL_MASTER_AFTER="$(git -C "$WORK_REPO" rev-parse refs/heads/master)"
if [[ "$LOCAL_MASTER_AFTER" != "$UPSTREAM_MASTER_TARGET" ]]; then
  echo "FAIL: refs/heads/master should be $UPSTREAM_MASTER_TARGET, got $LOCAL_MASTER_AFTER"
  cat "$TMP_DIR/supervisor.log"
  exit 1
fi

# HEAD must still be on the original worker branch — phase 1 must never check
# out master or move the working tree.
HEAD_BRANCH_AFTER="$(git -C "$WORK_REPO" rev-parse --abbrev-ref HEAD)"
if [[ "$HEAD_BRANCH_AFTER" != "$HEAD_BRANCH_BEFORE" ]]; then
  echo "FAIL: HEAD branch changed: $HEAD_BRANCH_BEFORE -> $HEAD_BRANCH_AFTER"
  exit 1
fi

# refs/remotes/upstream/master must exist and match the upstream target SHA.
REMOTE_TRACKING="$(git -C "$WORK_REPO" rev-parse refs/remotes/upstream/master 2>/dev/null || true)"
if [[ "$REMOTE_TRACKING" != "$UPSTREAM_MASTER_TARGET" ]]; then
  echo "FAIL: refs/remotes/upstream/master should be $UPSTREAM_MASTER_TARGET, got '$REMOTE_TRACKING'"
  exit 1
fi

# Recreate enqueue: at least one runner call must have shape
#   --headless --no-track recreate wf-1000-1
if ! grep -Eq '^--headless --no-track recreate wf-1000-1$' "$CALL_LOG"; then
  echo "FAIL: expected '--headless --no-track recreate wf-1000-1' in runner call log"
  echo "Call log:"
  cat "$CALL_LOG"
  exit 1
fi

# The single-cycle run must NOT have recreated the running workflow — the
# stall path requires repeated identical incomplete sets, which one cycle
# cannot produce.
if grep -Eq '^--headless --no-track recreate wf-1001-1$' "$CALL_LOG"; then
  echo "FAIL: running workflow should not be recreated on the first cycle"
  cat "$CALL_LOG"
  exit 1
fi

echo "PASS: prod-recreate-supervisor performs upstream ref sync without checkout/reset and enqueues recreate for failed workflows"
