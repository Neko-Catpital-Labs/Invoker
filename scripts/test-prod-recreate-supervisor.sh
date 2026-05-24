#!/usr/bin/env bash
# Focused test for scripts/prod-recreate-supervisor.sh.
#
# Coverage:
#   1. Static: script contains the upstream fetch refspec and update-ref shape.
#   2. Static: script does NOT use `git checkout master`, `git reset --hard`,
#      or known repo-pool-mirror mutation patterns.
#   3. Static: recreate enqueue uses `node scripts/headless-ipc.js exec ... recreate "$wf_id"`.
#   4. Functional: --sync-master-only fetches refs/heads/master from a fake
#      upstream and updates refs/heads/master via update-ref WITHOUT
#      changing HEAD or touching the working tree.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/prod-recreate-supervisor.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 1) Static: upstream fetch and update-ref behavior present
# ---------------------------------------------------------------------------

[[ -f "$SCRIPT" ]] || fail "missing $SCRIPT"
[[ -x "$SCRIPT" ]] || fail "$SCRIPT is not executable"

grep -Eq 'git fetch[^|;&]+refs/heads/[^"]*:refs/remotes/' "$SCRIPT" \
  || fail "expected 'git fetch <remote> refs/heads/...:refs/remotes/...' refspec"

grep -Eq 'git rev-parse[^|;&]+refs/remotes/' "$SCRIPT" \
  || fail "expected 'git rev-parse' against refs/remotes/<remote>/<ref>"

grep -Eq 'git update-ref[^|;&]+refs/heads/' "$SCRIPT" \
  || fail "expected 'git update-ref refs/heads/<ref>' usage"

# ---------------------------------------------------------------------------
# 2) Static: must NOT checkout master, reset --hard, or mutate repo-pool mirrors
# ---------------------------------------------------------------------------

# Strip comment lines so descriptive prose about what the script does NOT do
# is not flagged. Whole-line and trailing comments are removed.
SCRIPT_CODE="$(sed -E -e 's/^[[:space:]]*#.*$//' -e 's/([^"'"'"'\\])#.*$/\1/' "$SCRIPT")"

if printf '%s\n' "$SCRIPT_CODE" | grep -nE 'git[[:space:]]+checkout([[:space:]]+-[Bb])?[[:space:]]+(master|"\$\{?MASTER_REF\}?")'; then
  fail "script must not checkout master"
fi
if printf '%s\n' "$SCRIPT_CODE" | grep -nE 'git[[:space:]]+switch[[:space:]]+(master|"\$\{?MASTER_REF\}?")'; then
  fail "script must not switch to master"
fi
if printf '%s\n' "$SCRIPT_CODE" | grep -nE 'git[[:space:]]+reset[[:space:]]+(--hard|-[A-Za-z]*h)'; then
  fail "script must not 'git reset --hard'"
fi
if printf '%s\n' "$SCRIPT_CODE" | grep -nE '(repo-pool|repos-mirror|invoker/repos/|INVOKER_REPO_CACHE)'; then
  fail "script must not reference repo-pool mirror paths"
fi

# ---------------------------------------------------------------------------
# 3) Static: recreate enqueue command shape
# ---------------------------------------------------------------------------

grep -Eq 'node[[:space:]]+scripts/headless-ipc\.js[[:space:]]+exec[[:space:]].*--no-track' "$SCRIPT" \
  || fail "expected enqueue via 'node scripts/headless-ipc.js exec --no-track'"

grep -Eq 'recreate[[:space:]]+"\$\{?wf_id\}?"' "$SCRIPT" \
  || fail "expected recreate enqueue to pass \"\$wf_id\""

# ---------------------------------------------------------------------------
# 4) Functional: --sync-master-only exercises fetch + update-ref safely
# ---------------------------------------------------------------------------

TMP="$(mktemp -d -t prod-recreate-supervisor-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

UPSTREAM="$TMP/upstream.git"
WORK="$TMP/work"
OTHER="$TMP/other"
LOG_FILE="$TMP/supervisor.log"

git init --bare -q "$UPSTREAM"
git -C "$UPSTREAM" symbolic-ref HEAD refs/heads/master

git init -q "$WORK"
git -C "$WORK" config user.email "supervisor-test@example.com"
git -C "$WORK" config user.name "supervisor-test"
git -C "$WORK" checkout -q -B master
echo "seed" > "$WORK/README.md"
git -C "$WORK" add README.md
git -C "$WORK" commit -q -m "seed"
git -C "$WORK" remote add upstream "$UPSTREAM"
git -C "$WORK" push -q upstream master

# Advance upstream/master by one commit via a side clone (simulates an
# external update arriving on the canonical branch).
git clone -q "$UPSTREAM" "$OTHER"
git -C "$OTHER" config user.email "supervisor-test@example.com"
git -C "$OTHER" config user.name "supervisor-test"
git -C "$OTHER" checkout -q -B master origin/master
echo "advance" > "$OTHER/README.md"
git -C "$OTHER" add README.md
git -C "$OTHER" commit -q -m "advance"
git -C "$OTHER" push -q origin master

EXPECTED_SHA="$(git -C "$UPSTREAM" rev-parse refs/heads/master)"
LOCAL_BEFORE="$(git -C "$WORK" rev-parse refs/heads/master)"

[[ "$EXPECTED_SHA" != "$LOCAL_BEFORE" ]] \
  || fail "test setup did not advance upstream/master"

# Move HEAD onto a feature branch and dirty the working tree. The supervisor
# must leave both untouched.
git -C "$WORK" checkout -q -b feature/local
echo "dirty" > "$WORK/scratch.txt"

DIRTY_BEFORE="$(cat "$WORK/scratch.txt")"
HEAD_BEFORE="$(git -C "$WORK" rev-parse --abbrev-ref HEAD)"

# Run the supervisor in sync-only mode against the fake work repo.
INVOKER_PROD_SUPERVISOR_WORK_DIR="$WORK" \
INVOKER_PROD_SUPERVISOR_LOG="$LOG_FILE" \
  bash "$SCRIPT" --sync-master-only >/dev/null

LOCAL_AFTER="$(git -C "$WORK" rev-parse refs/heads/master)"
HEAD_AFTER="$(git -C "$WORK" rev-parse --abbrev-ref HEAD)"
DIRTY_AFTER="$(cat "$WORK/scratch.txt")"

[[ "$LOCAL_AFTER" == "$EXPECTED_SHA" ]] \
  || fail "refs/heads/master not advanced (expected $EXPECTED_SHA got $LOCAL_AFTER)"
[[ "$LOCAL_AFTER" != "$LOCAL_BEFORE" ]] \
  || fail "refs/heads/master unchanged after sync"
[[ "$HEAD_AFTER" == "feature/local" ]] \
  || fail "HEAD must remain on feature/local; got $HEAD_AFTER"
[[ "$HEAD_BEFORE" == "$HEAD_AFTER" ]] \
  || fail "HEAD changed during sync ($HEAD_BEFORE -> $HEAD_AFTER)"
[[ "$DIRTY_AFTER" == "$DIRTY_BEFORE" ]] \
  || fail "working tree mutated during sync"

# Verify the supervisor logged the expected phase markers.
grep -q "phase=sync-master fetch upstream refs/heads/master:refs/remotes/upstream/master" "$LOG_FILE" \
  || fail "log missing fetch phase marker"
grep -q "phase=sync-master update-ref refs/heads/master -> $EXPECTED_SHA" "$LOG_FILE" \
  || fail "log missing update-ref phase marker"

# A second run with no upstream advance is a no-op (idempotent fast-forward).
INVOKER_PROD_SUPERVISOR_WORK_DIR="$WORK" \
INVOKER_PROD_SUPERVISOR_LOG="$LOG_FILE" \
  bash "$SCRIPT" --sync-master-only >/dev/null

LOCAL_AFTER_2="$(git -C "$WORK" rev-parse refs/heads/master)"
[[ "$LOCAL_AFTER_2" == "$EXPECTED_SHA" ]] \
  || fail "second sync should be a no-op; refs/heads/master changed"

# Sanity: SKIP_MASTER_SYNC=1 leaves refs/heads/master alone even when upstream advances.
git clone -q "$UPSTREAM" "$TMP/other2"
git -C "$TMP/other2" config user.email "supervisor-test@example.com"
git -C "$TMP/other2" config user.name "supervisor-test"
git -C "$TMP/other2" checkout -q -B master origin/master
echo "advance2" > "$TMP/other2/README.md"
git -C "$TMP/other2" add README.md
git -C "$TMP/other2" commit -q -m "advance2"
git -C "$TMP/other2" push -q origin master

BEFORE_SKIP="$(git -C "$WORK" rev-parse refs/heads/master)"
INVOKER_PROD_SUPERVISOR_WORK_DIR="$WORK" \
INVOKER_PROD_SUPERVISOR_LOG="$LOG_FILE" \
INVOKER_PROD_SUPERVISOR_SKIP_MASTER_SYNC=1 \
  bash "$SCRIPT" --sync-master-only >/dev/null
AFTER_SKIP="$(git -C "$WORK" rev-parse refs/heads/master)"
[[ "$BEFORE_SKIP" == "$AFTER_SKIP" ]] \
  || fail "SKIP_MASTER_SYNC=1 must leave refs/heads/master untouched"

echo "PASS: prod-recreate-supervisor sync-master-only and command-shape checks"
