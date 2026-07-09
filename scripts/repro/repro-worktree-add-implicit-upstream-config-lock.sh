#!/usr/bin/env bash
set -euo pipefail

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-worktree-upstream-config-lock.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

origin_repo="$TMP_DIR/origin.git"
seed_repo="$TMP_DIR/seed"
mirror_repo="$TMP_DIR/mirror"
bad_worktree="$TMP_DIR/bad-worktree"
good_worktree="$TMP_DIR/good-worktree"

git init --bare "$origin_repo" >/dev/null
git clone "$origin_repo" "$seed_repo" >/dev/null 2>&1
git -C "$seed_repo" config user.email "repro@example.com"
git -C "$seed_repo" config user.name "Repro"
printf 'seed\n' > "$seed_repo/README.md"
git -C "$seed_repo" add README.md
git -C "$seed_repo" commit -m "seed" >/dev/null
git -C "$seed_repo" push origin HEAD:master >/dev/null

git clone "$origin_repo" "$mirror_repo" >/dev/null 2>&1
git -C "$mirror_repo" fetch origin '+refs/heads/*:refs/remotes/origin/*' >/dev/null

config_lock="$(git -C "$mirror_repo" rev-parse --absolute-git-dir)/config.lock"
touch "$config_lock"

set +e
bad_output="$(
  git -C "$mirror_repo" worktree add -B repro/bad "$bad_worktree" origin/master 2>&1
)"
bad_status=$?
set -e

if [[ "$bad_status" -eq 0 ]]; then
  echo "FAIL: expected git worktree add -B from origin/master to fail while config.lock exists" >&2
  exit 1
fi

if ! grep -Eqi 'could not lock config file|unable to write upstream branch configuration|config\.lock' <<<"$bad_output"; then
  echo "FAIL: expected upstream config lock failure, got:" >&2
  printf '%s\n' "$bad_output" >&2
  exit 1
fi

git -C "$mirror_repo" worktree add --no-track -B repro/good "$good_worktree" origin/master >/dev/null

upstream="$(git -C "$good_worktree" config --get branch.repro/good.remote || true)"
if [[ -n "$upstream" ]]; then
  echo "FAIL: --no-track worktree branch unexpectedly recorded upstream remote: $upstream" >&2
  exit 1
fi

echo "PASS: --no-track avoids implicit upstream config writes during worktree branch creation"
