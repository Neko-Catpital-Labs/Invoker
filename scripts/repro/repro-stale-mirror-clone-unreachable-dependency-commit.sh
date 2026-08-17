#!/usr/bin/env bash
set -euo pipefail

# Reproduces the DO5->DO3 stall (workflow wf-1786788062899-48): a downstream
# task's remote mirror clone (buildMirrorCloneScript, ssh-git-exec.ts) is
# shared and reused across tasks, keyed only by repo hash -- it is not
# recreated per task. If that clone's one `fetch --all --prune` runs before
# a dependency task pushes its result branch, the clone never sees that
# commit. Before the fix, nothing re-fetches or fails loudly for this: the
# caller (ssh-executor.ts) unconditionally treats the dependency's recorded
# commit hash as resolvable and proceeds straight to `git worktree add`,
# which fails with "fatal: invalid reference" two steps later -- with no
# retry anywhere in the chain, permanently wedging the workflow's merge gate.
#
# The fix (ssh-git-exec.ts buildMirrorCloneScript + ssh-executor.ts) adds an
# explicit `requiredCommit` check with a bounded, backed-off retry loop right
# after the initial fetch, so a normal propagation lag self-heals instead of
# stalling the workflow forever.

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/stale-mirror-clone-repro.XXXXXX")"
trap 'rm -rf "$tmp_dir"' EXIT

origin="$tmp_dir/origin.git"
seed="$tmp_dir/seed"
shared_mirror="$tmp_dir/shared-mirror"    # the long-lived, reused clone (e.g. on DO3)
upstream_task="$tmp_dir/upstream-task"    # simulates DO5's fix-ci worktree

git init --bare "$origin" >/dev/null 2>&1
git clone "$origin" "$seed" >/dev/null 2>&1
git -C "$seed" config user.email "repro@example.com"
git -C "$seed" config user.name "Repro"
git -C "$seed" checkout -B master >/dev/null 2>&1
printf 'base\n' >"$seed/file.txt"
git -C "$seed" add file.txt
git -C "$seed" commit -m base >/dev/null
git -C "$seed" push origin master >/dev/null 2>&1
git --git-dir="$origin" symbolic-ref HEAD refs/heads/master

# --- Step 1: the shared mirror clone gets created and fetched BEFORE the
#     dependency's branch is ever pushed -- the normal steady state, since
#     the clone is reused across tasks rather than recreated per task.
git clone "$origin" "$shared_mirror" >/dev/null 2>&1
git -C "$shared_mirror" fetch --all --prune >/dev/null 2>&1

# --- Step 2: the UPSTREAM task ("fix-ci" on DO5) commits and pushes a new
#     experiment branch AFTER the shared mirror's fetch already ran --
#     exactly what wf-1786788062899-48 did at 14:21:57 UTC on 2026-08-15.
git clone "$origin" "$upstream_task" >/dev/null 2>&1
git -C "$upstream_task" config user.email "repro@example.com"
git -C "$upstream_task" config user.name "Repro"
git -C "$upstream_task" checkout -B "experiment/wf-repro/fix-ci/g0.t0.a-deadbeef" master >/dev/null 2>&1
printf 'fix\n' >"$upstream_task/fix.txt"
git -C "$upstream_task" add fix.txt
git -C "$upstream_task" commit -m "fix" >/dev/null
dependency_commit="$(git -C "$upstream_task" rev-parse HEAD)"
git -C "$upstream_task" push origin "experiment/wf-repro/fix-ci/g0.t0.a-deadbeef" >/dev/null 2>&1

echo "dependency_commit=$dependency_commit"
echo "confirmed pushed to origin (matches: GitHub API confirmed the real branch existed):"
git --git-dir="$origin" rev-parse --verify "refs/heads/experiment/wf-repro/fix-ci/g0.t0.a-deadbeef" \
  || fail "setup broken: push didn't land"

# --- Step 3: the downstream task's worktree setup (setupTaskBranch /
#     buildWorktreeSandboxResetScript in the real code) tries to check out
#     the dependency's recorded commit against the now-stale shared clone,
#     without ever re-fetching -- this is the pre-fix behavior.
set +e
worktree_out="$(git -C "$shared_mirror" worktree add --no-track -B "verify-task-branch" \
  "$tmp_dir/verify-worktree" "$dependency_commit" 2>&1)"
worktree_exit=$?
set -e

echo "---"
echo "worktree_add_exit=$worktree_exit"
echo "worktree_add_output=$worktree_out"

if [[ "$worktree_exit" -eq 0 ]]; then
  fail "expected the downstream worktree setup to fail against the stale shared mirror clone, but it succeeded"
fi

if ! grep -Eqi 'invalid reference|not a valid object name|reference is not a tree|Needed a single revision|unknown revision|bad object|ambiguous argument' <<<"$worktree_out"; then
  fail "downstream failed, but not with the expected unresolvable-commit error"
fi

echo "PASS: reproduced 'fatal: invalid reference' on a downstream task whose shared mirror clone's fetch predated the dependency's push -- matches the real DO5->DO3 (wf-1786788062899-48) incident exactly."
echo
echo "--- proving the commit was never actually lost, only a fetch-retry away (matches: re-fetching the real orphaned commit from GitHub succeeded immediately after the fact) ---"
git -C "$shared_mirror" fetch --all --prune >/dev/null 2>&1
retry_out="$(git -C "$shared_mirror" worktree add --no-track -B "verify-task-branch-retry" \
  "$tmp_dir/verify-worktree-retry" "$dependency_commit" 2>&1)"
retry_exit=$?
echo "retry_after_fetch_exit=$retry_exit"
if [[ "$retry_exit" -ne 0 ]]; then
  fail "retry after a real fetch should have succeeded -- something else is wrong"
fi
echo "PASS: a single retried fetch resolves it completely -- this is exactly what buildMirrorCloneScript's requiredCommit retry loop now does automatically."
