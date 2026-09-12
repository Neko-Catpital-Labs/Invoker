#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/check-merge-clean.sh [--include-current-diff] <base-ref> <merge-ref> [<merge-ref>...]

Checks whether the refs merge cleanly in a temporary worktree. With
--include-current-diff, the current worktree diff is applied before merging so
uncommitted repairs can be verified without mutating the caller's worktree.
USAGE
}

include_current_diff=0
if [[ "${1:-}" == "--include-current-diff" ]]; then
  include_current_diff=1
  shift
fi

if (( ${#@} < 2 )); then
  usage
  exit 2
fi

base_ref="$1"
shift

repo_root="$(git rev-parse --show-toplevel)"
temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-merge-check.XXXXXX")"
worktree_dir="$temp_dir/worktree"
diff_file="$temp_dir/current.diff"

cleanup() {
  if git -C "$worktree_dir" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$worktree_dir" merge --abort >/dev/null 2>&1 || true
  fi
  git -C "$repo_root" worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true
  rm -rf "$temp_dir"
}
trap cleanup EXIT

git -C "$repo_root" worktree add --detach --quiet "$worktree_dir" "$base_ref"

if [[ "$include_current_diff" == "1" ]]; then
  git -C "$repo_root" diff --binary HEAD >"$diff_file"
  git -C "$repo_root" diff --cached --binary HEAD >>"$diff_file"
  if [[ -s "$diff_file" ]]; then
    git -C "$worktree_dir" apply --index "$diff_file"
    git -C "$worktree_dir" \
      -c user.email=merge-check@example.invalid \
      -c user.name='Merge Check' \
      commit --quiet -m 'merge-check current diff'
  fi
fi

for merge_ref in "$@"; do
  git -C "$worktree_dir" merge --no-ff --no-edit "$merge_ref"
done

if [[ -n "$(git -C "$worktree_dir" status --porcelain)" ]]; then
  git -C "$worktree_dir" status --short
  exit 1
fi

printf 'merge-clean: %s <- %s\n' "$base_ref" "$*"
