#!/usr/bin/env bash
# Repro: a stacked proof PR whose predecessor has already landed, but whose
# own commit is tree-empty, resolves to an empty PR diff. The trusted PR Body
# validator rejects that shape as "PR has no file changes; close it instead of
# merging it."
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-body-empty-proof.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "[repro] FAILED: $1" >&2
  exit 1
}

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

git checkout -q -b proof-pr
echo "installer reconciliation behavior" > installer.txt
git add installer.txt
git commit -q -m "behavior: installer reconciliation"
BEHAVIOR_COMMIT="$(git rev-parse HEAD)"
git commit -q --allow-empty -m "proof: empty verification slice"
HEAD_SHA="$(git rev-parse HEAD)"
git push -q origin HEAD:refs/heads/proof-pr

git checkout -q master
git cherry-pick "$BEHAVIOR_COMMIT" >/dev/null
git commit -q --amend -m "behavior: installer reconciliation landed by squash"
git push -q origin HEAD:refs/heads/master

CI="$TMP/ci-checkout"
git clone -q "$TMP/origin.git" "$CI"
cd "$CI"
git fetch -q origin "+refs/heads/proof-pr:refs/remotes/pull/12270/head"

export BASE_REF=master
export HEAD_SHA="$HEAD_SHA"
bash "$ROOT/scripts/fetch-pr-diff-metadata.sh"

echo "[repro] changed-files.txt:"
if [ -s changed-files.txt ]; then
  sed 's/^/  /' changed-files.txt
else
  echo "  <empty>"
fi

[ ! -s changed-files.txt ] || fail "changed-files.txt was not empty"
[ "$(wc -c < pr.diff)" -eq 0 ] || fail "pr.diff was not empty"

echo "[repro] passed: empty proof slice resolves to an empty PR diff"
