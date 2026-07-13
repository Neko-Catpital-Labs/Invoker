#!/usr/bin/env bash
set -euo pipefail

TASK_ID="${TASK_ID:-wf-1780400659189-5/implement-autofix-worker}"
DB_PATH="${INVOKER_DB_PATH:-${HOME:-}/.invoker/invoker.db}"

if [ ! -f "$DB_PATH" ]; then
  echo "missing Invoker DB: $DB_PATH" >&2
  exit 2
fi

read_task_field() {
  local field="$1"
  sqlite3 "$DB_PATH" "SELECT $field FROM tasks WHERE id = '$TASK_ID';"
}

WORKTREE_PATH="${WORKTREE_PATH:-$(read_task_field workspace_path)}"
OURS_BRANCH="${OURS_BRANCH:-$(read_task_field branch)}"
THEIRS_BRANCH="${THEIRS_BRANCH:-$(sqlite3 "$DB_PATH" "SELECT json_extract(error, '$.failedBranch') FROM tasks WHERE id = '$TASK_ID';")}"
CONFLICT_FILE="${CONFLICT_FILE:-packages/app/src/headless.ts}"

if [ -z "$WORKTREE_PATH" ] || [ ! -e "$WORKTREE_PATH/.git" ]; then
  echo "missing task worktree for $TASK_ID: $WORKTREE_PATH" >&2
  exit 2
fi

resolve_ref() {
  local ref="$1"
  if git -C "$WORKTREE_PATH" rev-parse --verify --quiet "$ref^{commit}" >/dev/null; then
    printf '%s\n' "$ref"
    return 0
  fi
  if git -C "$WORKTREE_PATH" rev-parse --verify --quiet "origin/$ref^{commit}" >/dev/null; then
    printf '%s\n' "origin/$ref"
    return 0
  fi
  echo "missing git ref: $ref" >&2
  return 1
}

OURS_REF="$(resolve_ref "$OURS_BRANCH")"
THEIRS_REF="$(resolve_ref "$THEIRS_BRANCH")"
BASE_REF="$(git -C "$WORKTREE_PATH" merge-base "$OURS_REF" "$THEIRS_REF")"
MERGE_TREE_OUTPUT="$(git -C "$WORKTREE_PATH" merge-tree "$BASE_REF" "$OURS_REF" "$THEIRS_REF")"

if printf '%s\n' "$MERGE_TREE_OUTPUT" | grep -Fq "$CONFLICT_FILE" \
  && printf '%s\n' "$MERGE_TREE_OUTPUT" | grep -Fq '<<<<<<<'; then
  echo "PASS: merge conflict reproduced for $TASK_ID"
  echo "ours=$OURS_REF"
  echo "theirs=$THEIRS_REF"
  echo "base=$BASE_REF"
  printf '%s\n' "$MERGE_TREE_OUTPUT" | grep -n -E "changed in both|<<<<<<<|=======|>>>>>>>|$CONFLICT_FILE" | head -40
  exit 0
fi

echo "FAIL: expected merge conflict was not reproduced for $TASK_ID" >&2
echo "ours=$OURS_REF" >&2
echo "theirs=$THEIRS_REF" >&2
echo "base=$BASE_REF" >&2
exit 1
