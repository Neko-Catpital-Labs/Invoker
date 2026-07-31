#!/usr/bin/env bash
# Repro: a PR's recorded base.sha can go stale relative to its real
# merge-base with the base branch -- e.g. GitHub freezes base.sha at the
# moment a stacked PR auto-retargets onto its predecessor's merge commit,
# and never refreshes it as the base branch (or the PR branch, via a later
# stack rebase) keeps moving. Pushing new commits to the PR head does not
# refresh it either. Confirmed live on
# https://github.com/Neko-Catpital-Labs/Invoker/pull/6583, where pr-body.yml
# diffed against a stale base.sha and picked up 6 unrelated scripts/ files
# that were never part of the PR, tripping the "behavior can't ship with
# tooling-policy files" review-unit rule.
#
# This builds a small local repo reproducing that shape: a base branch that
# advances after the PR forks, and a PR branch whose *true* merge-base with
# the base branch (after picking up that later commit, same as a stack
# rebase would) is newer than the stale base.sha the event would report.
# It then runs scripts/fetch-pr-diff-metadata.sh -- the actual script
# pr-body.yml calls -- and asserts the phantom file does not leak into the
# diff while the PR's real change is still present.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-body-stale-base.XXXXXX")"
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

# The PR forks here. This is what the (stale) event base.sha will point at.
STALE_BASE_SHA="$(git rev-parse HEAD)"
git checkout -q -b pr-branch
echo "pr change" > feature.txt
git add feature.txt
git commit -q -m "pr: add feature"
git push -q origin HEAD:refs/heads/pr-branch

# Master advances -- simulates a stacked predecessor PR merging after the
# fork point.
git checkout -q master
echo "unrelated master change" > unrelated.txt
git add unrelated.txt
git commit -q -m "master: unrelated change that lands after the PR forked"
git push -q origin HEAD:refs/heads/master

# The PR branch later picks up that master commit (e.g. a Mergify stack
# rebase), so its TRUE merge-base with master becomes this later commit --
# not STALE_BASE_SHA.
git checkout -q pr-branch
git merge -q master -m "pr: pick up later master (stack rebase)"
HEAD_SHA="$(git rev-parse HEAD)"
git push -q -f origin HEAD:refs/heads/pr-branch

CI="$TMP/ci-checkout"
git clone -q "$TMP/origin.git" "$CI"
cd "$CI"
git fetch -q origin "+refs/heads/pr-branch:refs/remotes/pull/999/head"

export BASE_REF=master
export BASE_SHA="$STALE_BASE_SHA"
export HEAD_SHA="$HEAD_SHA"
bash "$ROOT/scripts/fetch-pr-diff-metadata.sh"

echo "[repro] changed-files.txt:"
sed 's/^/  /' changed-files.txt

if grep -qx "unrelated.txt" changed-files.txt; then
  echo "[repro] FAILED: unrelated.txt (only reachable via the stale base.sha gap) leaked into the diff" >&2
  exit 1
fi
if ! grep -qx "feature.txt" changed-files.txt; then
  echo "[repro] FAILED: feature.txt (the PR's real change) is missing from the diff" >&2
  exit 1
fi
echo "[repro] passed: diff resolved against the live merge-base, not the stale base.sha"
