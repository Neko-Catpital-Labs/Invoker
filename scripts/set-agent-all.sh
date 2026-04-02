#!/usr/bin/env bash
# Change execution agent for all AI tasks across all workflows.
#
# Usage:
#   bash scripts/set-agent-all.sh codex          # switch all AI tasks to codex
#   bash scripts/set-agent-all.sh claude          # switch all AI tasks to claude
#   bash scripts/set-agent-all.sh codex --dry-run # show what would change
#
# Requires: running Invoker instance (for invoker-ctl HTTP API) and jq.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CTL="$SCRIPT_DIR/../invoker-ctl"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed." >&2
  exit 1
fi

TARGET="${1:-}"
DRY_RUN=false

if [ -z "$TARGET" ]; then
  echo "Usage: set-agent-all.sh <claude|codex> [--dry-run]" >&2
  exit 1
fi

if [ "$TARGET" != "claude" ] && [ "$TARGET" != "codex" ]; then
  echo "Error: agent must be 'claude' or 'codex', got '$TARGET'" >&2
  exit 1
fi

if [ "${2:-}" = "--dry-run" ]; then
  DRY_RUN=true
fi

# Query all non-merge tasks as JSONL via headless CLI
TASKS=$("$CTL" tasks | jq -c '
  .[] |
  select(.config.isMergeNode != true) |
  select(.config.command == null) |
  select(.config.prompt != null) |
  {id: .id, description: .description, currentAgent: (.config.executionAgent // "claude")}
' 2>/dev/null) || {
  echo "Error: failed to query tasks. Is Invoker running?" >&2
  exit 1
}

if [ -z "$TASKS" ]; then
  echo "No AI tasks found."
  exit 0
fi

COUNT=0
SKIPPED=0

while IFS= read -r line; do
  TASK_ID=$(echo "$line" | jq -r '.id')
  DESC=$(echo "$line" | jq -r '.description')
  CURRENT=$(echo "$line" | jq -r '.currentAgent')

  if [ "$CURRENT" = "$TARGET" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "[dry-run] $TASK_ID: $CURRENT → $TARGET  ($DESC)"
  else
    echo "$TASK_ID: $CURRENT → $TARGET  ($DESC)"
    "$CTL" edit-agent "$TASK_ID" "$TARGET"
  fi
  COUNT=$((COUNT + 1))
done <<< "$TASKS"

echo ""
if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete: $COUNT task(s) would change, $SKIPPED already on $TARGET."
else
  echo "Done: $COUNT task(s) changed to $TARGET, $SKIPPED already on $TARGET."
fi
