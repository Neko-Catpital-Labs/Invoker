#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

CANONICAL_REPO="$TMP_DIR/canonical.git"
PUBLISH_REPO="$TMP_DIR/publish.git"
WORK_REPO="$TMP_DIR/work"

git init --bare "$CANONICAL_REPO" >/dev/null
git init --bare "$PUBLISH_REPO" >/dev/null

git clone "$CANONICAL_REPO" "$WORK_REPO" >/dev/null
git -C "$WORK_REPO" remote add publish "$PUBLISH_REPO"

git -C "$WORK_REPO" config user.email "test@example.com"
git -C "$WORK_REPO" config user.name "test-user"
echo "seed" > "$WORK_REPO/README.md"
git -C "$WORK_REPO" add README.md
git -C "$WORK_REPO" commit -m "seed" >/dev/null
git -C "$WORK_REPO" push origin master >/dev/null
git -C "$WORK_REPO" push publish master >/dev/null

out_explicit="$(
  cd "$WORK_REPO"
  bash "$ROOT/scripts/create-clean-pr-branch.sh" \
    --base-remote origin \
    --publish-remote publish \
    --base-ref master \
    pr/explicit
)"

[[ "$(git -C "$WORK_REPO" rev-parse --abbrev-ref HEAD)" == "pr/explicit" ]] || {
  echo "expected current branch pr/explicit"
  exit 1
}
printf '%s' "$out_explicit" | rg -q 'git push -u publish pr/explicit'

git -C "$WORK_REPO" switch master >/dev/null

out_alias="$(
  cd "$WORK_REPO"
  bash "$ROOT/scripts/create-clean-pr-branch.sh" \
    --parent-remote origin \
    --publish-remote publish \
    --base-ref master \
    pr/alias
)"

[[ "$(git -C "$WORK_REPO" rev-parse --abbrev-ref HEAD)" == "pr/alias" ]] || {
  echo "expected current branch pr/alias"
  exit 1
}
printf '%s' "$out_alias" | rg -q 'git push -u publish pr/alias'

echo "PASS: create-clean-pr-branch supports upstream-first remotes and alias"
