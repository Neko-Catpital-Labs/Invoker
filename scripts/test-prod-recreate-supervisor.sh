#!/usr/bin/env bash
# Focused test for scripts/prod-recreate-supervisor.sh
#
# Verifies:
#   1. Phase 1 (git fetch upstream master + git update-ref refs/heads/master)
#      moves refs/heads/master to match upstream/master in-place, without
#      checking out master and without resetting the current branch's
#      working tree.
#   2. The script source rejects `git checkout master`, `git reset --hard`,
#      and any reference to repo-pool mirror mutation.
#   3. The script source enqueues recreate via the headless mutation shape
#      `headless_mutation --no-track recreate <workflow-id>`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/prod-recreate-supervisor.sh"

if [[ ! -f "$SCRIPT" ]]; then
  echo "FAIL: missing supervisor script at $SCRIPT" >&2
  exit 1
fi
if [[ ! -x "$SCRIPT" ]]; then
  echo "FAIL: supervisor script is not executable" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d -t prod-recreate-supervisor-test.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

UPSTREAM_BARE="$TMP_DIR/upstream.git"
WORK_REPO="$TMP_DIR/work"

git init --bare --initial-branch=master "$UPSTREAM_BARE" >/dev/null

git init --initial-branch=master "$WORK_REPO" >/dev/null
git -C "$WORK_REPO" config user.email "supervisor-test@example.com"
git -C "$WORK_REPO" config user.name  "supervisor-test"
echo "seed" > "$WORK_REPO/README.md"
git -C "$WORK_REPO" add README.md
git -C "$WORK_REPO" commit -m "seed" >/dev/null
git -C "$WORK_REPO" push "$UPSTREAM_BARE" master:master >/dev/null 2>&1

git -C "$WORK_REPO" remote add upstream "$UPSTREAM_BARE"

OLD_SHA="$(git -C "$WORK_REPO" rev-parse refs/heads/master)"

# Advance upstream master by one commit (via a scratch clone).
CLONE_DIR="$TMP_DIR/upstream-clone"
git clone "$UPSTREAM_BARE" "$CLONE_DIR" >/dev/null 2>&1
git -C "$CLONE_DIR" config user.email "supervisor-test@example.com"
git -C "$CLONE_DIR" config user.name  "supervisor-test"
echo "upstream advance" > "$CLONE_DIR/upstream.txt"
git -C "$CLONE_DIR" add upstream.txt
git -C "$CLONE_DIR" commit -m "upstream advance" >/dev/null
git -C "$CLONE_DIR" push origin master >/dev/null 2>&1
NEW_UPSTREAM_SHA="$(git -C "$CLONE_DIR" rev-parse refs/heads/master)"

if [[ "$NEW_UPSTREAM_SHA" == "$OLD_SHA" ]]; then
  echo "FAIL: test setup did not advance upstream master" >&2
  exit 1
fi

# Move the work repo onto a feature branch with a local untracked file so the
# test can prove the supervisor did NOT checkout master and did NOT discard
# working state.
git -C "$WORK_REPO" checkout -b feature/test >/dev/null 2>&1
echo "local change" > "$WORK_REPO/local.txt"

# ---------------------------------------------------------------------------
# Exercise: run the supervisor for one cycle with headless calls disabled.
# ---------------------------------------------------------------------------

SUPERVISOR_LOG="$TMP_DIR/supervisor.log"
SUPERVISOR_REPO_DIR="$WORK_REPO" \
INVOKER_SUPERVISOR_SKIP_HEADLESS=1 \
MAX_CYCLES=1 \
INTERVAL_SECONDS=1 \
STALL_CYCLES=10 \
UPSTREAM_REMOTE=upstream \
bash "$SCRIPT" >"$SUPERVISOR_LOG" 2>&1

# ---------------------------------------------------------------------------
# Phase 1 assertions
# ---------------------------------------------------------------------------

UPDATED_MASTER="$(git -C "$WORK_REPO" rev-parse refs/heads/master)"
if [[ "$UPDATED_MASTER" != "$NEW_UPSTREAM_SHA" ]]; then
  echo "FAIL: refs/heads/master not advanced to upstream (got $UPDATED_MASTER, expected $NEW_UPSTREAM_SHA)" >&2
  cat "$SUPERVISOR_LOG" >&2
  exit 1
fi
if [[ "$UPDATED_MASTER" == "$OLD_SHA" ]]; then
  echo "FAIL: refs/heads/master not updated at all (still $OLD_SHA)" >&2
  cat "$SUPERVISOR_LOG" >&2
  exit 1
fi

CURRENT_BRANCH="$(git -C "$WORK_REPO" rev-parse --abbrev-ref HEAD)"
if [[ "$CURRENT_BRANCH" != "feature/test" ]]; then
  echo "FAIL: current branch should still be feature/test, got $CURRENT_BRANCH" >&2
  cat "$SUPERVISOR_LOG" >&2
  exit 1
fi

if [[ ! -f "$WORK_REPO/local.txt" ]]; then
  echo "FAIL: local file was removed; supervisor must not reset/clean working tree" >&2
  exit 1
fi

git -C "$WORK_REPO" rev-parse --verify refs/remotes/upstream/master >/dev/null

echo "PASS phase 1: refs/heads/master synced to upstream without checkout/reset"

# ---------------------------------------------------------------------------
# Static rejection: forbidden patterns
# ---------------------------------------------------------------------------

# Strip comment lines before pattern checks so the script can freely document
# the forbidden behaviors it deliberately avoids.
CODE_ONLY="$TMP_DIR/script-code-only.sh"
grep -vE '^[[:space:]]*#' "$SCRIPT" >"$CODE_ONLY"

if grep -nE 'git[[:space:]]+([^|]*[[:space:]])?checkout[[:space:]]+master\b' "$CODE_ONLY" >/dev/null; then
  echo "FAIL: supervisor must not run 'git checkout master'" >&2
  grep -nE 'git[[:space:]]+([^|]*[[:space:]])?checkout[[:space:]]+master\b' "$CODE_ONLY" >&2
  exit 1
fi

if grep -nE 'reset[[:space:]]+--hard' "$CODE_ONLY" >/dev/null; then
  echo "FAIL: supervisor must not run 'git reset --hard'" >&2
  grep -nE 'reset[[:space:]]+--hard' "$CODE_ONLY" >&2
  exit 1
fi

if grep -nE '(repo-pool|repoPool|RepoPool)' "$CODE_ONLY" >/dev/null; then
  echo "FAIL: supervisor must not mutate repo-pool mirrors" >&2
  grep -nE '(repo-pool|repoPool|RepoPool)' "$CODE_ONLY" >&2
  exit 1
fi

echo "PASS static rejection: no checkout/reset/repo-pool mutation patterns"

# ---------------------------------------------------------------------------
# Static requirement: phase 1 + recreate command shape present
# ---------------------------------------------------------------------------

if ! grep -nE 'git[[:space:]]+-C[[:space:]]+"\$WORKDIR"[[:space:]]+fetch[[:space:]]+"\$UPSTREAM_REMOTE"' "$SCRIPT" >/dev/null; then
  echo "FAIL: supervisor must run 'git -C \"\$WORKDIR\" fetch \"\$UPSTREAM_REMOTE\" ...'" >&2
  exit 1
fi

if ! grep -nE 'refs/heads/master:.*refs/remotes/' "$SCRIPT" >/dev/null; then
  echo "FAIL: supervisor must fetch refs/heads/master into refs/remotes/<upstream>/master" >&2
  exit 1
fi

if ! grep -nE 'update-ref[[:space:]]+refs/heads/master\b' "$SCRIPT" >/dev/null; then
  echo "FAIL: supervisor must use 'git update-ref refs/heads/master'" >&2
  exit 1
fi

if ! grep -nE 'headless_mutation[[:space:]]+--no-track[[:space:]]+recreate[[:space:]]+"\$[A-Za-z_][A-Za-z0-9_]*"' "$SCRIPT" >/dev/null; then
  echo "FAIL: supervisor must enqueue recreate via 'headless_mutation --no-track recreate \"\$<id>\"'" >&2
  exit 1
fi

echo "PASS static requirement: upstream fetch, update-ref, and recreate enqueue shapes present"

echo "PASS prod-recreate-supervisor focused test"
