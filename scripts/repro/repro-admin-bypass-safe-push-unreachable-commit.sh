#!/usr/bin/env bash
set -euo pipefail

# Reproduces the admin-bypass repair handoff failure with real git repos.
#
# The repair task prompt told the agent to check out the real PR head branch.
# BaseExecutor then recorded HEAD from that PR branch, but pre-fix pushBranchToRemote
# published refs/heads/$task_branch because the current branch was different.
# A fresh downstream safe-push workspace cannot resolve the recorded commit.

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/admin-bypass-unreachable-commit.XXXXXX")"
if [[ "${KEEP_TEMP:-0}" != "1" ]]; then
  trap 'rm -rf "$tmp_dir"' EXIT
else
  trap 'printf "kept temp dir: %s\n" "$tmp_dir"' EXIT
fi

origin="$tmp_dir/origin.git"
seed="$tmp_dir/seed"
repair="$tmp_dir/repair"
mirror="$tmp_dir/mirror"
safe_push_worktree="$tmp_dir/safe-push-worktree"

base_branch="stack/base"
pr_branch="stack/pr-head"
task_branch="experiment/wf-admin-bypass-repro/repair/g0.t0.a-deadbeef"
safe_push_branch="experiment/wf-admin-bypass-repro/safe-push/g0.t0.a-cafebabe"

git init --bare "$origin" >/dev/null 2>&1
git clone "$origin" "$seed" >/dev/null 2>&1
git -C "$seed" config user.email "repro@example.com"
git -C "$seed" config user.name "Admin Bypass Repro"

git -C "$seed" checkout -B master >/dev/null 2>&1
printf 'base\n' >"$seed/file.txt"
git -C "$seed" add file.txt
git -C "$seed" commit -m "base" >/dev/null

git -C "$seed" checkout -B "$base_branch" >/dev/null 2>&1
base_sha="$(git -C "$seed" rev-parse HEAD)"
git -C "$seed" push origin "$base_branch:refs/heads/$base_branch" >/dev/null 2>&1

git -C "$seed" checkout -B "$pr_branch" "$base_branch" >/dev/null 2>&1
printf 'pr head\n' >"$seed/pr.txt"
git -C "$seed" add pr.txt
git -C "$seed" commit -m "pr head" >/dev/null
pr_sha="$(git -C "$seed" rev-parse HEAD)"
git -C "$seed" push origin "$pr_branch:refs/heads/$pr_branch" >/dev/null 2>&1

git -C "$seed" checkout -B "$task_branch" "$base_branch" >/dev/null 2>&1
git -C "$seed" push origin "$task_branch:refs/heads/$task_branch" >/dev/null 2>&1

git clone "$origin" "$repair" >/dev/null 2>&1
git -C "$repair" config user.email "repro@example.com"
git -C "$repair" config user.name "Admin Bypass Repro"
git -C "$repair" fetch origin '+refs/heads/*:refs/remotes/origin/*' >/dev/null 2>&1
git -C "$repair" checkout -B "$task_branch" "origin/$task_branch" >/dev/null 2>&1

# Simulate the deployed admin-bypass repair prompt:
#   git fetch origin <head_ref> && git checkout <head_ref>
git -C "$repair" fetch origin "$pr_branch" >/dev/null 2>&1
git -C "$repair" checkout -B "$pr_branch" "origin/$pr_branch" >/dev/null 2>&1
printf 'repair commit made while on PR branch\n' >>"$repair/pr.txt"
git -C "$repair" add pr.txt
git -C "$repair" commit -m "repair on PR branch" >/dev/null
recorded_commit="$(git -C "$repair" rev-parse HEAD)"

# Simulate the pre-fix BaseExecutor.pushBranchToRemote source-ref selection:
# if the worktree is not on the task branch, push refs/heads/$task_branch.
current_branch="$(git -C "$repair" branch --show-current)"
if [[ -z "$current_branch" || "$current_branch" == "$task_branch" ]]; then
  source_ref="HEAD"
else
  source_ref="refs/heads/$task_branch"
fi
source_sha="$(git -C "$repair" rev-parse --verify "$source_ref^{commit}")"
git -C "$repair" push --force-with-lease origin "$source_sha:refs/heads/$task_branch" >/dev/null 2>&1

remote_task_sha="$(git --git-dir="$origin" rev-parse "refs/heads/$task_branch")"
if [[ "$remote_task_sha" == "$recorded_commit" ]]; then
  fail "task branch unexpectedly points at the recorded repair commit"
fi

git clone "$origin" "$mirror" >/dev/null 2>&1
set +e
startup_output="$(
  git -C "$mirror" worktree add --no-track -B "$safe_push_branch" "$safe_push_worktree" "$recorded_commit" 2>&1
)"
startup_code=$?
set -e

if [[ "$startup_code" -eq 0 ]]; then
  fail "fresh downstream workspace unexpectedly resolved the unpublished repair commit"
fi

if ! grep -Eqi 'invalid reference|not a valid object name|reference is not a tree|Needed a single revision|unknown revision|bad object|ambiguous argument' <<<"$startup_output"; then
  printf '%s\n' "$startup_output" >&2
  fail "downstream failed, but not with an unresolvable commit/reference error"
fi

printf 'base_sha=%s\n' "$base_sha"
printf 'pr_sha=%s\n' "$pr_sha"
printf 'recorded_repair_commit=%s\n' "$recorded_commit"
printf 'published_task_branch_sha=%s\n' "$remote_task_sha"
printf 'executor_source_ref=%s\n' "$source_ref"
printf 'downstream_startup_status=%s\n' "$startup_code"
printf 'downstream_startup_error=%s\n' "$(printf '%s' "$startup_output" | tail -n 1)"
printf 'PASS: reproduced unreachable recorded repair commit for downstream safe-push task\n'
