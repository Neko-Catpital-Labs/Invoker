#!/usr/bin/env bash
# Repro: PR Body validation fetches the PR head first, then
# scripts/fetch-pr-diff-metadata.sh refreshes the base branch before computing
# the live merge-base. A self-hosted runner can fail that second network fetch
# due to runner TLS/CA configuration even when the trusted base checkout already
# has a usable origin/<base> ref. The validator should use that cached base ref
# only when it can still compute a merge-base with the already-fetched PR head.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-body-base-fetch-fallback.XXXXXX")"
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

git checkout -q -b pr-branch
echo "pr change" > feature.txt
git add feature.txt
git commit -q -m "pr: add feature"
HEAD_SHA="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/pr-branch

CI="$TMP/ci-checkout"
git clone -q --depth=1 "file://$TMP/origin.git" "$CI"
cd "$CI"
git fetch -q --depth=1000 origin "+refs/heads/pr-branch:refs/remotes/pull/999/head"

# Keep the checked-out origin/master and fetched PR head, but make the script's
# base refresh fail like the CI log's TLS failure. The script must not hide this
# unless the cached refs are sufficient to compute the same diff metadata.
git remote set-url origin "https://127.0.0.1:1/Neko-Catpital-Labs/Invoker.git"

export BASE_REF=master
export HEAD_SHA="$HEAD_SHA"
bash "$ROOT/scripts/fetch-pr-diff-metadata.sh"

echo "[repro] changed-files.txt:"
sed 's/^/  /' changed-files.txt

if ! grep -qx "feature.txt" changed-files.txt; then
  echo "[repro] FAILED: feature.txt (the PR's real change) is missing from the diff" >&2
  exit 1
fi
if grep -qx "README.md" changed-files.txt; then
  echo "[repro] FAILED: cached base fallback leaked base-only files into the diff" >&2
  exit 1
fi

echo "[repro] passed: cached base fallback kept the PR diff available after base refresh failure"
