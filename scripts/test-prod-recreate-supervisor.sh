#!/usr/bin/env bash
# Focused test for scripts/prod-recreate-supervisor.sh.
#
# Verifies that the supervisor:
#   1. Contains and exercises the upstream fetch + update-ref behavior.
#   2. Does NOT use git checkout / git switch / git reset --hard, and does NOT
#      mutate repo-pool mirrors under ~/.invoker/repos.
#   3. Encodes the recreate enqueue command shape we expect to invoke against
#      the headless IPC bridge.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"

if [[ ! -x "$SCRIPT" ]]; then
  echo "FAIL: $SCRIPT must exist and be executable" >&2
  exit 1
fi

fail() {
  echo "FAIL: $1" >&2
  exit 1
}

# ----- 1. Static checks: phase-1 ref-sync surface -----

grep -qE 'git +(-C +"[^"]+" +)?fetch ' "$SCRIPT" \
  || fail "expected a 'git ... fetch' call in $SCRIPT"

grep -qE 'refs/heads/[^[:space:]"]+:refs/remotes/' "$SCRIPT" \
  || fail "expected refspec 'refs/heads/<branch>:refs/remotes/<remote>/<branch>' in $SCRIPT"

grep -qE 'update-ref +refs/heads/' "$SCRIPT" \
  || fail "expected 'git update-ref refs/heads/...' in $SCRIPT"

grep -qE 'rev-parse' "$SCRIPT" \
  || fail "expected the script to resolve the upstream ref via 'git rev-parse'"

# ----- 2. Static checks: prohibited working-tree mutations -----
#
# Strip shell comments before grepping so the script's own header
# documentation (which describes what the script must NOT do) doesn't
# trigger false positives.
CODE_ONLY="$(grep -vE '^[[:space:]]*#' "$SCRIPT")"

if printf '%s\n' "$CODE_ONLY" | grep -nE 'git +(-C +[^ ]+ +)?checkout( |$)'; then
  fail "script must not use 'git checkout' (Phase 1 must not move HEAD)"
fi

if printf '%s\n' "$CODE_ONLY" | grep -nE 'git +(-C +[^ ]+ +)?switch( |$)'; then
  fail "script must not use 'git switch' (Phase 1 must not move HEAD)"
fi

if printf '%s\n' "$CODE_ONLY" | grep -nE 'reset +--hard'; then
  fail "script must not use 'git reset --hard'"
fi

if printf '%s\n' "$CODE_ONLY" | grep -nE '\.invoker/repos'; then
  fail "script must not mutate repo-pool mirrors under ~/.invoker/repos"
fi

# ----- 3. Static check: recreate enqueue command shape -----

grep -qE 'headless-ipc\.js"? +exec +--no-track +-- +recreate +"\$wf_id"' "$SCRIPT" \
  || fail "expected enqueue shape 'headless-ipc.js exec --no-track -- recreate \"\$wf_id\"' in $SCRIPT"

grep -qE 'INVOKER_HEADLESS_IPC_DISPATCH_ATTEMPTS=' "$SCRIPT" \
  || fail "expected recreate enqueue to set INVOKER_HEADLESS_IPC_DISPATCH_ATTEMPTS for retry-on-busy"

# ----- 4. Static check: tunable env knobs are present -----

for knob in \
  INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS \
  INVOKER_PROD_SUPERVISOR_MAX_CYCLES \
  INVOKER_PROD_SUPERVISOR_STALL_CYCLES; do
  grep -qE "${knob}" "$SCRIPT" \
    || fail "expected env knob ${knob} to be referenced in $SCRIPT"
done

# ----- 5. Functional check: phase 1 actually advances refs/heads/master -----
#
# Build a self-contained sandbox: a bare "upstream" repo, a working repo that
# tracks it, and a *separate* clone that advances the upstream past the
# working repo's local master. Then we switch the working repo off of master
# onto a feature branch, run the supervisor in --sync-master-only mode, and
# assert:
#   - the current branch did NOT change (HEAD unmoved)
#   - refs/heads/master DID move to the upstream tip
#   - the working tree was not mutated

TMP_DIR="$(mktemp -d -t prod-recreate-supervisor-test.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

UPSTREAM_BARE="$TMP_DIR/upstream.git"
WORK="$TMP_DIR/work"
ADVANCER="$TMP_DIR/advancer"

git init --bare --initial-branch=master "$UPSTREAM_BARE" >/dev/null

git init --initial-branch=master "$WORK" >/dev/null
git -C "$WORK" config user.email "test@example.com"
git -C "$WORK" config user.name "test-user"
git -C "$WORK" remote add upstream "$UPSTREAM_BARE"
echo "v1" > "$WORK/file.txt"
git -C "$WORK" add file.txt
git -C "$WORK" commit -m "v1" >/dev/null
git -C "$WORK" push upstream master >/dev/null 2>&1
INITIAL_MASTER="$(git -C "$WORK" rev-parse refs/heads/master)"

git clone "$UPSTREAM_BARE" "$ADVANCER" >/dev/null 2>&1
git -C "$ADVANCER" config user.email "test@example.com"
git -C "$ADVANCER" config user.name "test-user"
echo "v2" > "$ADVANCER/file.txt"
git -C "$ADVANCER" add file.txt
git -C "$ADVANCER" commit -m "v2" >/dev/null
git -C "$ADVANCER" push origin master >/dev/null 2>&1
EXPECTED_MASTER="$(git -C "$ADVANCER" rev-parse HEAD)"

[[ "$EXPECTED_MASTER" != "$INITIAL_MASTER" ]] \
  || fail "test fixture: upstream master should have advanced past local master"

# Move the working repo onto a feature branch so the test is a real check
# that phase 1 leaves HEAD alone.
git -C "$WORK" checkout -b feature/keep-me >/dev/null 2>&1
echo "wip" >> "$WORK/file.txt"
git -C "$WORK" add file.txt
git -C "$WORK" commit -m "wip on feature" >/dev/null
INITIAL_HEAD="$(git -C "$WORK" rev-parse HEAD)"
INITIAL_BRANCH="$(git -C "$WORK" rev-parse --abbrev-ref HEAD)"
INITIAL_WORKTREE_HASH="$(git -C "$WORK" hash-object file.txt)"

LOG_FILE="$TMP_DIR/supervisor.log"
INVOKER_PROD_SUPERVISOR_REPO_ROOT="$WORK" \
  bash "$SCRIPT" --sync-master-only --log "$LOG_FILE"

FINAL_HEAD="$(git -C "$WORK" rev-parse HEAD)"
FINAL_BRANCH="$(git -C "$WORK" rev-parse --abbrev-ref HEAD)"
FINAL_MASTER="$(git -C "$WORK" rev-parse refs/heads/master)"
FINAL_REMOTE_REF="$(git -C "$WORK" rev-parse refs/remotes/upstream/master)"
FINAL_WORKTREE_HASH="$(git -C "$WORK" hash-object file.txt)"

[[ "$FINAL_HEAD" == "$INITIAL_HEAD" ]] \
  || fail "HEAD moved during sync (was $INITIAL_HEAD, now $FINAL_HEAD)"
[[ "$FINAL_BRANCH" == "$INITIAL_BRANCH" ]] \
  || fail "current branch changed (was $INITIAL_BRANCH, now $FINAL_BRANCH)"
[[ "$FINAL_WORKTREE_HASH" == "$INITIAL_WORKTREE_HASH" ]] \
  || fail "working tree mutated during sync (hash $INITIAL_WORKTREE_HASH -> $FINAL_WORKTREE_HASH)"
[[ "$FINAL_MASTER" == "$EXPECTED_MASTER" ]] \
  || fail "refs/heads/master not advanced to upstream (got $FINAL_MASTER, expected $EXPECTED_MASTER)"
[[ "$FINAL_REMOTE_REF" == "$EXPECTED_MASTER" ]] \
  || fail "refs/remotes/upstream/master not populated (got $FINAL_REMOTE_REF, expected $EXPECTED_MASTER)"
[[ "$INITIAL_MASTER" != "$FINAL_MASTER" ]] \
  || fail "refs/heads/master was unchanged after sync"

grep -q 'phase1 fetch' "$LOG_FILE" \
  || fail "expected 'phase1 fetch' log line in $LOG_FILE"
grep -q 'phase1 update-ref refs/heads/master' "$LOG_FILE" \
  || fail "expected 'phase1 update-ref refs/heads/master' log line in $LOG_FILE"

echo "PASS: prod-recreate-supervisor.sh phase-1 sync works and shape checks pass"
