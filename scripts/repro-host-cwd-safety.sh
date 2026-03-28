#!/usr/bin/env bash
# Repro script: host-cwd safety gaps.
#
# Demonstrates 6 gaps where using the host repo (TaskExecutor cwd / repoRoot)
# instead of the pool clone leads to incorrect git operations.
#
# Setup:
#   invoker-repo  — simulates TaskExecutor cwd / repoRoot
#   pool-clone    — simulates RepoPool clone with experiment/task-1
#   merge-worktree — git clone --local from pool (squash-merge playground)
#   invoker-origin — bare remote for invoker-repo
#
# Usage:
#   ./scripts/repro-host-cwd-safety.sh
#
# Exit codes:
#   0 — all gaps demonstrated (all [PASS])
#   1 — at least one gap failed to reproduce ([FAIL])
set -euo pipefail

# ---------------------------------------------------------------------------
# Temp dir + cleanup
# ---------------------------------------------------------------------------
TMPBASE="$(mktemp -d "${TMPDIR:-/tmp}/repro-host-cwd-XXXXXX")"
trap 'rm -rf "$TMPBASE"' EXIT

INVOKER_ORIGIN="$TMPBASE/invoker-origin.git"
INVOKER_REPO="$TMPBASE/invoker-repo"
POOL_CLONE="$TMPBASE/pool-clone"
MERGE_WORKTREE="$TMPBASE/merge-worktree"

FAILURES=0

pass() { echo "[PASS] Gap $1: $2"; }
fail() { echo "[FAIL] Gap $1: $2"; FAILURES=$((FAILURES + 1)); }

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
echo "==> Setup: creating repos under $TMPBASE"

# Bare origin for invoker-repo (so gap 4 can show remote get-url).
git init --bare "$INVOKER_ORIGIN" >/dev/null 2>&1

# invoker-repo: simulate host TaskExecutor cwd / repoRoot.
git init "$INVOKER_REPO" >/dev/null 2>&1
git -C "$INVOKER_REPO" remote add origin "$INVOKER_ORIGIN"
echo "host file" > "$INVOKER_REPO/README.md"
git -C "$INVOKER_REPO" add -A
git -C "$INVOKER_REPO" commit -m "initial host commit" >/dev/null 2>&1
git -C "$INVOKER_REPO" push origin master >/dev/null 2>&1

# pool-clone: simulate RepoPool clone with an experiment branch.
git clone --local "$INVOKER_ORIGIN" "$POOL_CLONE" >/dev/null 2>&1
git -C "$POOL_CLONE" checkout -b experiment/task-1 >/dev/null 2>&1
echo "pool work" > "$POOL_CLONE/task.txt"
git -C "$POOL_CLONE" add -A
git -C "$POOL_CLONE" commit -m "pool: task-1 work" >/dev/null 2>&1

# merge-worktree: clone --local from pool (squash-merge playground).
git clone --local "$POOL_CLONE" "$MERGE_WORKTREE" >/dev/null 2>&1

# Record baseline SHAs.
INVOKER_MASTER_BEFORE="$(git -C "$INVOKER_REPO" rev-parse master)"
POOL_TASK_SHA="$(git -C "$POOL_CLONE" rev-parse experiment/task-1)"

echo ""

# ---------------------------------------------------------------------------
# Gap 1 — merge-executor: squash merge updates invoker master via detached HEAD
# ---------------------------------------------------------------------------
echo "==> Gap 1: merge-executor (squash merge into host repo)"

# Squash merge in the merge-worktree.
git -C "$MERGE_WORKTREE" checkout master >/dev/null 2>&1
git -C "$MERGE_WORKTREE" merge --squash experiment/task-1 >/dev/null 2>&1
git -C "$MERGE_WORKTREE" commit -m "squash: task-1" >/dev/null 2>&1
MERGE_SHA="$(git -C "$MERGE_WORKTREE" rev-parse HEAD)"

# Fetch the squash commit into invoker-repo.
git -C "$INVOKER_REPO" fetch "$MERGE_WORKTREE" HEAD >/dev/null 2>&1

# Detach HEAD on invoker to match the code path that uses update-ref.
git -C "$INVOKER_REPO" checkout --detach HEAD >/dev/null 2>&1
git -C "$INVOKER_REPO" update-ref refs/heads/master "$MERGE_SHA"
git -C "$INVOKER_REPO" checkout master >/dev/null 2>&1

INVOKER_MASTER_AFTER="$(git -C "$INVOKER_REPO" rev-parse master)"

if [ "$INVOKER_MASTER_AFTER" != "$INVOKER_MASTER_BEFORE" ] && \
   [ "$INVOKER_MASTER_AFTER" = "$MERGE_SHA" ]; then
  pass 1 "master ref updated on invoker-repo (${INVOKER_MASTER_AFTER:0:8})"
else
  fail 1 "master ref NOT updated (before=${INVOKER_MASTER_BEFORE:0:8} after=${INVOKER_MASTER_AFTER:0:8})"
fi

# ---------------------------------------------------------------------------
# Gap 2 — worktree-familiar + base-familiar: autoCommit in host cwd
# ---------------------------------------------------------------------------
echo "==> Gap 2: worktree-familiar (autoCommit stages host WIP)"

git -C "$INVOKER_REPO" checkout -b experiment/host-wip >/dev/null 2>&1
echo "accidental WIP" > "$INVOKER_REPO/wip-file.txt"
git -C "$INVOKER_REPO" add -A
git -C "$INVOKER_REPO" commit -m "autoCommit: WIP from host cwd" >/dev/null 2>&1

if git -C "$INVOKER_REPO" log --oneline -1 | grep -q "autoCommit"; then
  pass 2 "WIP commit created in host repo (simulates effectiveCwd fallback to repoDir)"
else
  fail 2 "no WIP commit found"
fi

# Return to master for later gaps.
git -C "$INVOKER_REPO" checkout master >/dev/null 2>&1

# ---------------------------------------------------------------------------
# Gap 3 — workflow-actions: branch delete on host vs pool
# ---------------------------------------------------------------------------
echo "==> Gap 3: workflow-actions (branch delete on host, pool unaffected)"

# Create experiment/task-1 on invoker then delete it.
git -C "$INVOKER_REPO" branch experiment/task-1 "$INVOKER_MASTER_BEFORE" 2>/dev/null || true
git -C "$INVOKER_REPO" branch -D experiment/task-1 >/dev/null 2>&1

# Pool must still have it at the original SHA.
POOL_TASK_SHA_AFTER="$(git -C "$POOL_CLONE" rev-parse experiment/task-1 2>/dev/null || echo "MISSING")"

if [ "$POOL_TASK_SHA_AFTER" = "$POOL_TASK_SHA" ]; then
  pass 3 "pool experiment/task-1 intact (${POOL_TASK_SHA:0:8})"
else
  fail 3 "pool experiment/task-1 changed or missing (was ${POOL_TASK_SHA:0:8}, now ${POOL_TASK_SHA_AFTER:0:8})"
fi

# ---------------------------------------------------------------------------
# Gap 4 — remote mismatch: host origin != pool origin
# ---------------------------------------------------------------------------
echo "==> Gap 4: remote mismatch (push from host.cwd uses wrong remote)"

INVOKER_REMOTE="$(git -C "$INVOKER_REPO" remote get-url origin)"
echo "  invoker origin: $INVOKER_REMOTE"

if [ -n "$INVOKER_REMOTE" ]; then
  pass 4 "invoker has its own origin — push would target host remote, not pool"
else
  fail 4 "invoker has no origin configured"
fi

# ---------------------------------------------------------------------------
# Gap 5 — task-executor: clone from host cwd inherits host provenance
# ---------------------------------------------------------------------------
echo "==> Gap 5: task-executor (clone --local from host inherits host provenance)"

EXEC_CLONE="$TMPBASE/exec-clone"
git clone --local --no-checkout "$INVOKER_REPO" "$EXEC_CLONE" >/dev/null 2>&1

EXEC_ORIGIN="$(git -C "$EXEC_CLONE" remote get-url origin)"

if [ "$EXEC_ORIGIN" = "$INVOKER_REPO" ]; then
  pass 5 "exec-clone origin points at invoker-repo ($EXEC_ORIGIN)"
else
  # Also accept alternates-based linkage.
  if [ -f "$EXEC_CLONE/.git/objects/info/alternates" ]; then
    pass 5 "exec-clone uses alternates linked to invoker-repo"
  else
    fail 5 "exec-clone origin unexpected: $EXEC_ORIGIN"
  fi
fi

# ---------------------------------------------------------------------------
# Gap 6 — worktree-familiar: HEAD divergence between host and pool
# ---------------------------------------------------------------------------
echo "==> Gap 6: worktree-familiar (HEAD SHA differs between host and pool)"

INVOKER_HEAD="$(git -C "$INVOKER_REPO" rev-parse HEAD)"
POOL_HEAD="$(git -C "$POOL_CLONE" rev-parse HEAD)"

if [ "$INVOKER_HEAD" != "$POOL_HEAD" ]; then
  pass 6 "HEADs differ — invoker=${INVOKER_HEAD:0:8} pool=${POOL_HEAD:0:8}"
else
  fail 6 "HEADs match (${INVOKER_HEAD:0:8}) — expected divergence"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [ "$FAILURES" -eq 0 ]; then
  echo "All 6 gaps demonstrated successfully."
  exit 0
else
  echo "$FAILURES gap(s) failed to reproduce."
  exit 1
fi
