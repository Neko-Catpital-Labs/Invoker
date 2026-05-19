#!/usr/bin/env bash
set -euo pipefail

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-approved-fix-stale-wt.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

git_init() {
  git -c init.defaultBranch=master "$@"
}

origin="$tmpdir/origin.git"
seed="$tmpdir/seed"
mirror="$tmpdir/mirror"
stale_wt="$tmpdir/worktrees/stale-task"
owner_wt="$tmpdir/worktrees/current-task"
branch="experiment/wf-1/test-task"

git_init init --bare "$origin" >/dev/null
git_init clone "$origin" "$seed" >/dev/null
git -C "$seed" config user.name "Invoker Repro"
git -C "$seed" config user.email "invoker-repro@example.com"
printf 'base\n' >"$seed/result.txt"
git -C "$seed" add result.txt
git -C "$seed" commit -m "seed" >/dev/null
git -C "$seed" push origin master >/dev/null

git clone "$origin" "$mirror" >/dev/null
git -C "$mirror" config user.name "Invoker Repro"
git -C "$mirror" config user.email "invoker-repro@example.com"
git -C "$mirror" worktree add -B "$branch" "$owner_wt" origin/master >/dev/null
printf 'approved fix\n' >"$owner_wt/result.txt"

mkdir -p "$(dirname "$stale_wt")"
git -C "$mirror" worktree add -B stale/old "$stale_wt" origin/master >/dev/null
git -C "$mirror" worktree remove --force "$stale_wt" >/dev/null

if git -C "$stale_wt" status >/tmp/invoker-stale-wt.out 2>&1; then
  echo "repro: expected stale recorded workspace to fail" >&2
  exit 1
fi

if ! grep -E "No such file|not a git repository|cannot change to" /tmp/invoker-stale-wt.out >/dev/null; then
  echo "repro: stale path failed for an unexpected reason:" >&2
  cat /tmp/invoker-stale-wt.out >&2
  exit 1
fi

resolved_wt="$(
  git -C "$mirror" worktree list --porcelain |
    awk -v branch="refs/heads/$branch" '
      /^worktree / { path=substr($0, 10) }
      /^branch / && substr($0, 8) == branch { print path; found=1 }
      END { if (!found) exit 1 }
    '
)"

resolved_wt_real="$(cd "$resolved_wt" && pwd -P)"
owner_wt_real="$(cd "$owner_wt" && pwd -P)"
if [[ "$resolved_wt_real" != "$owner_wt_real" ]]; then
  echo "repro: expected branch owner $owner_wt_real, got $resolved_wt_real" >&2
  exit 1
fi

git -C "$resolved_wt" add -A
git -C "$resolved_wt" commit -m "approved fix" >/dev/null
git -C "$resolved_wt" push origin "HEAD:refs/heads/$branch" >/dev/null

remote_value="$(git -C "$mirror" show "origin/$branch:result.txt" 2>/dev/null || true)"
if [[ "$remote_value" != "approved fix" ]]; then
  echo "repro: expected approved fix to be pushed, got: $remote_value" >&2
  exit 1
fi

echo "PASS: approved-fix publish must repair stale workspacePath from git worktree branch ownership"
