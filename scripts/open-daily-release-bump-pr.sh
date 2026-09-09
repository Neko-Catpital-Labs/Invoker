#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      TAG="${2:?missing tag}"
      shift 2
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 64
      ;;
  esac
done

if [ -z "$TAG" ]; then
  echo "--tag is required" >&2
  exit 64
fi

BRANCH="$(git branch --show-current)"
TITLE="[Daily Release Bump](1) Bump patch version for ${TAG}"

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT
sed "s/{{TAG}}/${TAG}/g" scripts/daily-release-bump-pr-body-template.txt > "$body_file"

git push --force-with-lease --set-upstream origin "$BRANCH"

node scripts/create-pr.mjs \
  --title "$TITLE" \
  --base master \
  --body-file "$body_file"

pr_number="$(gh pr list --state open --head "$BRANCH" --json number --jq '.[0].number // empty')"
if [ -z "$pr_number" ]; then
  echo "Could not resolve PR number for branch $BRANCH after create-pr.mjs" >&2
  exit 1
fi

gh pr edit "$pr_number" --add-label admin-bypass
echo "Opened bump PR #${pr_number}; the admin-bypass label queues it for merge."
