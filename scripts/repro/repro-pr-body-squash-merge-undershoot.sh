#!/usr/bin/env bash
# Repro: this repo's Mergify queues always squash-merge (.mergify.yml). When a
# stacked PR's predecessor lands that way, the squashed commit on the base
# branch has a different SHA/parents than this PR branch's own copy of that
# commit, so git ancestry breaks. scripts/fetch-pr-diff-metadata.sh's live
# merge-base resolution (added to fix stale base.sha, see
# repro-pr-body-stale-base-sha.sh) then walks past the predecessor all the way
# back to the original stack fork point, and the predecessor's own
# already-landed file leaks back into this PR's diff -- tripping the
# "single review unit per PR" rule on a PR that is otherwise correctly
# scoped. Confirmed live on
# https://github.com/Neko-Catpital-Labs/Invoker/pull/5933.
#
# This builds a small local repo reproducing that shape: a predecessor commit
# on a PR branch, squash-merged onto the base branch as a new, unrelated
# commit, with a successor commit stacked on top of the PR branch's original
# (non-squashed) predecessor commit. It then runs
# scripts/fetch-pr-diff-metadata.sh -- the actual script pr-body.yml calls --
# and asserts the predecessor's own file does not leak into the diff while
# the successor's real change is still present.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-body-squash-undershoot.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
git init -q --bare "$TMP/origin.git"
WORK="$TMP/work"
git clone -q "$TMP/origin.git" "$WORK"
cd "$WORK"
git config user.email test@example.com
git config user.name Test
echo base > README.md
git add README.md
git commit -q -m "base: initial"
git push -q origin HEAD:refs/heads/master
# The stack forks here.
git checkout -q -b pr-branch
echo "predecessor change" > predecessor.txt
git add predecessor.txt
git commit -q -m "predecessor: add predecessor.txt"
PREDECESSOR_SHA="$(git rev-parse HEAD)"
echo "successor change" > successor.txt
git add successor.txt
git commit -q -m "successor: add successor.txt"
HEAD_SHA="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/pr-branch
# The predecessor lands on master via squash merge -- a brand new commit with
# identical content but a different SHA and parents than pr-branch's own
# predecessor commit, breaking git ancestry between pr-branch and master.
git checkout -q master
git cherry-pick --no-commit "$PREDECESSOR_SHA"
git commit -q -m "predecessor: add predecessor.txt (#0000)"
BASE_SHA="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/master
CI="$TMP/ci-checkout"
git clone -q "$TMP/origin.git" "$CI"
cd "$CI"
git fetch -q origin "+refs/heads/pr-branch:refs/remotes/pull/999/head"
export BASE_REF=master
export BASE_SHA="$BASE_SHA"
export HEAD_SHA="$HEAD_SHA"
bash "$ROOT/scripts/fetch-pr-diff-metadata.sh"
echo "[repro] changed-files.txt:"
sed 's/^/  /' changed-files.txt
if grep -qx "predecessor.txt" changed-files.txt; then
  echo "[repro] FAILED: predecessor.txt (already landed on master via squash merge) leaked into the diff" >&2
  exit 1
fi
if ! grep -qx "successor.txt" changed-files.txt; then
  echo "[repro] FAILED: successor.txt (the PR's real change) is missing from the diff" >&2
  exit 1
fi
echo "[repro] passed: diff excluded the squash-merged predecessor's own file and kept the successor's real change"
