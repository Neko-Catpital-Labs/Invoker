#!/usr/bin/env bash
# Focused test for scripts/prod-recreate-supervisor.sh.
#
# Verifies:
#   1) Phase-1 contract — script contains and exercises the upstream fetch
#      + `git update-ref refs/heads/master` behavior.
#   2) Safety contract — script does NOT use destructive paths:
#        - no `git checkout master`
#        - no `git reset --hard`
#        - no mutation of the repo-pool mirrors (~/.invoker/repos)
#   3) Recreate enqueue command shape — script dispatches recreate through
#      the headless IPC helper with `exec --no-track -- recreate <wf_id>`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "FAIL: $SCRIPT not found" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d -t prod-recreate-supervisor-test.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# Stripped copy of the script — comments removed — used for safety checks
# that must not be fooled by a comment that names a forbidden command.
CODE_ONLY="$TMP_DIR/prod-recreate-supervisor.code-only.sh"
awk '
  {
    line = $0
    sub(/^[[:space:]]*#.*$/, "", line)
    # Strip trailing comments while leaving quoted "#" alone.
    out = ""
    in_single = 0
    in_double = 0
    i = 1
    while (i <= length(line)) {
      ch = substr(line, i, 1)
      if (ch == "\"" && !in_single) { in_double = !in_double; out = out ch; i++; continue }
      if (ch == "\047" && !in_double) { in_single = !in_single; out = out ch; i++; continue }
      if (ch == "#" && !in_single && !in_double) { break }
      out = out ch
      i++
    }
    print out
  }
' "$SCRIPT" > "$CODE_ONLY"

# ---------------------------------------------------------------------------
# 1) Static contract checks
# ---------------------------------------------------------------------------

# Phase-1 upstream fetch refspec — must fetch the upstream master ref into
# the remote-tracking ref, not into a local branch.
grep -Eq 'git fetch "?\$\{?remote\}?"? "?refs/heads/\$\{?branch\}?:refs/remotes/\$\{?remote\}?/\$\{?branch\}?"?' "$SCRIPT" \
  || fail "expected an upstream-style refspec fetch (refs/heads/<b>:refs/remotes/<remote>/<b>) in $SCRIPT"
pass "script contains upstream-refspec fetch"

# Phase-1 update-ref — must update refs/heads/<branch> (not HEAD, not the
# checked-out branch via checkout/reset).
grep -Eq 'git update-ref "?refs/heads/\$\{?branch\}?"?' "$SCRIPT" \
  || fail "expected 'git update-ref refs/heads/\${branch}' in $SCRIPT"
pass "script contains git update-ref refs/heads/<branch>"

# Safety: no checkout of master and no hard reset (code, not comments).
if grep -Eq 'git[[:space:]]+checkout[[:space:]]+(--[[:space:]]+)?master([[:space:]]|$)' "$CODE_ONLY"; then
  fail "script must not run 'git checkout master'"
fi
if grep -Eq 'git[[:space:]]+checkout[[:space:]]+"?\$\{?MASTER_BRANCH\}?"?' "$CODE_ONLY"; then
  fail "script must not run 'git checkout \$MASTER_BRANCH'"
fi
pass "script does not check out master"

if grep -Eq 'git[[:space:]]+reset[[:space:]]+--hard' "$CODE_ONLY"; then
  fail "script must not run 'git reset --hard'"
fi
pass "script does not run 'git reset --hard'"

# Safety: no repo-pool mirror mutation. The repo-pool lives under
# ~/.invoker/repos by convention; the supervisor must leave it alone.
if grep -Eq '\.invoker/repos' "$CODE_ONLY"; then
  fail "script must not touch repo-pool mirrors (~/.invoker/repos)"
fi
if grep -Eq 'repo-pool|repoPool' "$CODE_ONLY"; then
  fail "script must not reference repo-pool mirrors"
fi
pass "script does not touch repo-pool mirrors"

# Recreate enqueue command shape — must go through headless-ipc with
# --no-track and a `recreate <wf_id>` payload.
grep -Fq 'node scripts/headless-ipc.js exec --no-track -- recreate "$wf_id"' "$SCRIPT" \
  || fail "expected recreate enqueue 'node scripts/headless-ipc.js exec --no-track -- recreate \"\$wf_id\"' in $SCRIPT"
pass "script uses headless-ipc exec --no-track -- recreate <wf_id>"

# Env-knob contract.
for knob in \
  INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS \
  INVOKER_PROD_SUPERVISOR_MAX_CYCLES \
  INVOKER_PROD_SUPERVISOR_STALL_CYCLES
do
  grep -Fq "$knob" "$SCRIPT" || fail "expected env knob $knob in $SCRIPT"
done
pass "script exposes interval / max-cycles / stall-cycles env knobs"

# ---------------------------------------------------------------------------
# 2) Exercise the sync phase against a sandbox upstream
# ---------------------------------------------------------------------------

UPSTREAM_BARE="$TMP_DIR/upstream.git"
SEED_REPO="$TMP_DIR/seed"
HOST_REPO="$TMP_DIR/host"
LOG_FILE="$TMP_DIR/supervisor.log"

# Build a real bare "upstream" with two commits on master.
git init --bare --quiet "$UPSTREAM_BARE"

git init --quiet "$SEED_REPO"
git -C "$SEED_REPO" config user.email "supervisor-test@example.com"
git -C "$SEED_REPO" config user.name "supervisor-test"
git -C "$SEED_REPO" checkout -q -b master
echo "initial" > "$SEED_REPO/file.txt"
git -C "$SEED_REPO" add file.txt
git -C "$SEED_REPO" commit -q -m "initial"
echo "second" >> "$SEED_REPO/file.txt"
git -C "$SEED_REPO" commit -q -am "second"
git -C "$SEED_REPO" remote add origin "$UPSTREAM_BARE"
git -C "$SEED_REPO" push -q origin master

UPSTREAM_HEAD="$(git -C "$SEED_REPO" rev-parse refs/heads/master)"

# Host repo: simulate a long-running working tree on a feature branch with
# refs/heads/master pinned to an old (initial) commit. The supervisor must
# advance refs/heads/master without touching the checked-out feature branch.
git clone --quiet "$UPSTREAM_BARE" "$HOST_REPO"
git -C "$HOST_REPO" config user.email "supervisor-test@example.com"
git -C "$HOST_REPO" config user.name "supervisor-test"
git -C "$HOST_REPO" remote rename origin upstream
# Pin local master to the first commit so the supervisor has work to do.
INITIAL_SHA="$(git -C "$HOST_REPO" rev-list --max-parents=0 refs/remotes/upstream/master)"
git -C "$HOST_REPO" update-ref refs/heads/master "$INITIAL_SHA"
# Switch off master onto a feature branch so we can prove the supervisor
# never touched the working tree / current HEAD.
git -C "$HOST_REPO" checkout -q -b feature/keep-checked-out master
echo "local-only" > "$HOST_REPO/local.txt"
git -C "$HOST_REPO" add local.txt
git -C "$HOST_REPO" commit -q -m "local feature commit"

FEATURE_HEAD_BEFORE="$(git -C "$HOST_REPO" rev-parse HEAD)"
FEATURE_BRANCH_BEFORE="$(git -C "$HOST_REPO" rev-parse --abbrev-ref HEAD)"
MASTER_BEFORE="$(git -C "$HOST_REPO" rev-parse refs/heads/master)"

[[ "$MASTER_BEFORE" == "$INITIAL_SHA" ]] \
  || fail "test setup: expected host master at initial sha, got $MASTER_BEFORE"
[[ "$MASTER_BEFORE" != "$UPSTREAM_HEAD" ]] \
  || fail "test setup: host master already matches upstream head ($UPSTREAM_HEAD); no work to test"

# Drive the supervisor script in --sync-only mode against the sandbox host.
# Re-root the script at the sandbox by passing an explicit cd via env.
(
  INVOKER_PROD_SUPERVISOR_REPO_ROOT="$HOST_REPO" \
  INVOKER_PROD_SUPERVISOR_LOG="$LOG_FILE" \
  INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE="upstream" \
  INVOKER_PROD_SUPERVISOR_MASTER_BRANCH="master" \
  INVOKER_PROD_SUPERVISOR_INTERVAL_SECONDS=1 \
  INVOKER_PROD_SUPERVISOR_MAX_CYCLES=1 \
  INVOKER_PROD_SUPERVISOR_STALL_CYCLES=1 \
  bash "$SCRIPT" --sync-only
)

MASTER_AFTER="$(git -C "$HOST_REPO" rev-parse refs/heads/master)"
FEATURE_HEAD_AFTER="$(git -C "$HOST_REPO" rev-parse HEAD)"
FEATURE_BRANCH_AFTER="$(git -C "$HOST_REPO" rev-parse --abbrev-ref HEAD)"
REMOTE_TRACKING_AFTER="$(git -C "$HOST_REPO" rev-parse refs/remotes/upstream/master)"

[[ "$MASTER_AFTER" == "$UPSTREAM_HEAD" ]] \
  || fail "expected refs/heads/master to advance to $UPSTREAM_HEAD, got $MASTER_AFTER"
pass "phase 1 advanced refs/heads/master to upstream head"

[[ "$REMOTE_TRACKING_AFTER" == "$UPSTREAM_HEAD" ]] \
  || fail "expected refs/remotes/upstream/master at $UPSTREAM_HEAD, got $REMOTE_TRACKING_AFTER"
pass "phase 1 populated refs/remotes/upstream/master"

[[ "$FEATURE_HEAD_AFTER" == "$FEATURE_HEAD_BEFORE" ]] \
  || fail "phase 1 must not touch the checked-out HEAD ($FEATURE_HEAD_BEFORE -> $FEATURE_HEAD_AFTER)"
[[ "$FEATURE_BRANCH_AFTER" == "$FEATURE_BRANCH_BEFORE" ]] \
  || fail "phase 1 must not switch branches ($FEATURE_BRANCH_BEFORE -> $FEATURE_BRANCH_AFTER)"
pass "phase 1 left checked-out branch and HEAD untouched"

# Working tree must be clean (no checkout / reset side effects).
if [[ -n "$(git -C "$HOST_REPO" status --porcelain)" ]]; then
  fail "phase 1 dirtied the working tree"
fi
pass "phase 1 left working tree clean"

# Idempotency: a second --sync-only run with master already aligned must
# be a no-op and still exit 0.
(
  INVOKER_PROD_SUPERVISOR_REPO_ROOT="$HOST_REPO" \
  INVOKER_PROD_SUPERVISOR_LOG="$LOG_FILE" \
  INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE="upstream" \
  INVOKER_PROD_SUPERVISOR_MASTER_BRANCH="master" \
  bash "$SCRIPT" --sync-only
)
grep -Fq "refs/heads/master already at" "$LOG_FILE" \
  || fail "expected idempotent 'already at <sha>' log on second sync"
pass "phase 1 is idempotent when already aligned"

# Missing upstream remote: should warn and exit 0 (not abort the supervisor).
MISSING_REMOTE_REPO="$TMP_DIR/no-upstream"
git init --quiet "$MISSING_REMOTE_REPO"
git -C "$MISSING_REMOTE_REPO" config user.email "supervisor-test@example.com"
git -C "$MISSING_REMOTE_REPO" config user.name "supervisor-test"
git -C "$MISSING_REMOTE_REPO" checkout -q -b feature/no-upstream
echo "x" > "$MISSING_REMOTE_REPO/x.txt"
git -C "$MISSING_REMOTE_REPO" add x.txt
git -C "$MISSING_REMOTE_REPO" commit -q -m "x"
NO_UPSTREAM_LOG="$TMP_DIR/no-upstream.log"
(
  INVOKER_PROD_SUPERVISOR_REPO_ROOT="$MISSING_REMOTE_REPO" \
  INVOKER_PROD_SUPERVISOR_LOG="$NO_UPSTREAM_LOG" \
  INVOKER_PROD_SUPERVISOR_UPSTREAM_REMOTE="upstream-not-configured" \
  bash "$SCRIPT" --sync-only
)
grep -Fq "is not configured" "$NO_UPSTREAM_LOG" \
  || fail "expected 'is not configured' warning when upstream remote is missing"
pass "phase 1 degrades gracefully when upstream remote is missing"

echo ""
echo "ALL CHECKS PASSED: prod-recreate-supervisor.sh"
