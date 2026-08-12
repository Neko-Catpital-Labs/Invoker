#!/usr/bin/env bash
# Repro: pr-body.yml fetches the PR head before scripts/fetch-pr-diff-metadata.sh
# refreshes the base branch. If that later base refresh fails on a self-hosted
# runner, diff metadata generation currently exits before using the already
# cached origin/<base> ref, even when that cached ref is enough to compute the
# correct merge-base. Confirmed live on
# https://github.com/Neko-Catpital-Labs/Invoker/pull/8508.
#
# This builds a small local repo, creates a shallow CI-style checkout with
# origin/master cached, fetches the PR head into refs/remotes/pull/999/head,
# then points origin at an unreachable HTTPS URL before running the actual
# metadata helper. The current implementation fails at the base refresh. After
# the fallback fix, this same script should pass and prove the cached base ref
# produces the expected changed-files.txt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-body-base-fetch-cached-fallback.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

git init -q --bare "$TMP/origin.git"
git -C "$TMP/origin.git" symbolic-ref HEAD refs/heads/master

WORK="$TMP/work"
git clone -q "$TMP/origin.git" "$WORK"
cd "$WORK"
git config user.email test@example.com
git config user.name Test

echo base > README.md
git add README.md
git commit -q -m "base: initial"

echo "base-only change" > base-only.txt
git add base-only.txt
git commit -q -m "base: add base-only file"
BASE_SHA="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/master

git checkout -q -b pr-branch
echo "pr change" > pr-file.txt
git add pr-file.txt
git commit -q -m "pr: add pr-file"
git push -q origin HEAD:refs/heads/pr-branch

CI="$TMP/ci-checkout"
git clone -q --depth=2 "file://$TMP/origin.git" "$CI"
cd "$CI"
git fetch -q --depth=2 origin "+refs/heads/pr-branch:refs/remotes/pull/999/head"
HEAD_SHA="$(git rev-parse refs/remotes/pull/999/head)"
CACHED_MERGE_BASE="$(git merge-base origin/master "$HEAD_SHA")"
if [ "$CACHED_MERGE_BASE" != "$BASE_SHA" ]; then
  echo "[repro] FAILED: cached origin/master cannot compute the expected merge-base" >&2
  echo "[repro] expected: $BASE_SHA" >&2
  echo "[repro] actual:   $CACHED_MERGE_BASE" >&2
  exit 1
fi

# Simulate the PR head fetch having succeeded, followed by a network failure
# before the base refresh. The cached origin/master ref is still sufficient:
# merge-base(origin/master, HEAD_SHA) is BASE_SHA.
git remote set-url origin https://127.0.0.1:1/unreachable/repo.git

export BASE_REF=master
export BASE_SHA
export HEAD_SHA
bash "$ROOT/scripts/fetch-pr-diff-metadata.sh"

echo "[repro] changed-files.txt:"
sed 's/^/  /' changed-files.txt

if grep -qx "base-only.txt" changed-files.txt; then
  echo "[repro] FAILED: base-only.txt (already on cached origin/master) leaked into the diff" >&2
  exit 1
fi
if ! grep -qx "pr-file.txt" changed-files.txt; then
  echo "[repro] FAILED: pr-file.txt (the PR's real change) is missing from the diff" >&2
  exit 1
fi
echo "[repro] passed: cached origin/master was enough to compute the correct PR diff"
