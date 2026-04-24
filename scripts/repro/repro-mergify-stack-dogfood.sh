#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_REPO="${MERGIFY_STACK_DOGFOOD_REPO:-EdbertChan/Invoker}"
BASE_BRANCH="${MERGIFY_STACK_DOGFOOD_BASE:-master}"
RUN_ID="${MERGIFY_STACK_DOGFOOD_RUN_ID:-$(date +%Y%m%d%H%M%S)}"
PREFIX="${MERGIFY_STACK_DOGFOOD_PREFIX:-repro/mergify-stack-dogfood-$RUN_ID}"
TMPDIR_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-mergify-stack.XXXXXX")"
CLONE_DIR="$TMPDIR_ROOT/repo"
BRANCH="$PREFIX"

cleanup() {
  rm -rf "$TMPDIR_ROOT"
}
trap cleanup EXIT

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

require_cmd git
require_cmd gh
require_cmd mergify

echo "==> verifying GitHub access to $TARGET_REPO"
gh repo view "$TARGET_REPO" --json nameWithOwner,url >/dev/null

echo "==> cloning $TARGET_REPO"
git clone "https://github.com/$TARGET_REPO" "$CLONE_DIR" >/dev/null 2>&1
cd "$CLONE_DIR"

echo "==> ensuring Mergify commit-msg hook is installed"
mergify stack setup >/dev/null

echo "==> starting from $BASE_BRANCH"
git fetch origin "$BASE_BRANCH" >/dev/null 2>&1
git switch -c "$BRANCH" "origin/$BASE_BRANCH" >/dev/null

git config user.name "${GIT_AUTHOR_NAME:-EdbertChan}"
git config user.email "${GIT_AUTHOR_EMAIL:-edbert@example.com}"

echo "==> creating disposable stacked commits on $BRANCH"
printf '\nstack repro %s\n' "$RUN_ID" >> README.md
git add README.md
git commit -m "docs: add stack repro marker $RUN_ID" >/dev/null

printf '\nsecond stack repro %s\n' "$RUN_ID" >> README.md
git add README.md
git commit -m "docs: add second stack repro marker $RUN_ID" >/dev/null

echo "==> publishing stacked PRs with mergify stack push"
STACK_PUSH_LOG="$(mktemp "${TMPDIR:-/tmp}/mergify-stack-push.XXXXXX.log")"
mergify stack push 2>&1 | tee "$STACK_PUSH_LOG"

echo "==> verifying stacked PRs exist"
PR_NUMBERS="$(
  grep -Eo 'https://github.com/[^ ]+/pull/[0-9]+' "$STACK_PUSH_LOG" |
  sed -E 's#.*/pull/([0-9]+)#\1#' |
  sort -u
)"
if [ -z "$PR_NUMBERS" ]; then
  echo "expected mergify stack push to print PR URLs, found none" >&2
  exit 1
fi

PRS_JSON="$(
  while IFS= read -r pr_number; do
    [ -n "$pr_number" ] || continue
    gh pr view "$pr_number" --repo "$TARGET_REPO" \
      --json number,title,url,baseRefName,headRefName,state
  done <<<"$PR_NUMBERS" | jq -s '.'
)"
PR_COUNT="$(printf '%s' "$PRS_JSON" | jq 'length')"

echo "==> open PRs"
printf '%s\n' "$PRS_JSON" | jq -r '.[] | "- #" + (.number|tostring) + " " + .title + " [" + .baseRefName + " <- " + .headRefName + "] " + .url'

echo
echo "==> branch cleanup"
printf '%s\n' "$PRS_JSON" | jq -r '.[] | "gh pr close \(.number) --repo '"$TARGET_REPO"' --delete-branch"'
