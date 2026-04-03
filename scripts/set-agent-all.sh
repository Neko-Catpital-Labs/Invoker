#!/usr/bin/env bash
# Change execution agent for all AI tasks across all workflows.
#
# Usage:
#   bash scripts/set-agent-all.sh codex          # switch all AI tasks to codex
#   bash scripts/set-agent-all.sh claude          # switch all AI tasks to claude
#   bash scripts/set-agent-all.sh codex --dry-run # show what would change
#
# Uses headless CLI query/set commands:
#   1) query workflows
#   2) query tasks per workflow
#   3) set agent on AI tasks only
#
# Requires: jq.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

headless() {
  "$REPO_ROOT/run.sh" --headless "$@" 2>/dev/null
}

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

# Query all workflows first
WORKFLOWS="$(headless query workflows --output label | grep -E '^wf-[0-9]+-[0-9]+$' || true)"
if [ -z "$WORKFLOWS" ]; then
  echo "No workflows found."
  exit 0
fi

COUNT=0
SKIPPED=0
FAILED=0
WF_IDX=0
TOTAL_WF=$(echo "$WORKFLOWS" | wc -l | tr -d ' ')
DISPATCHED=0
INFLIGHT=0
MAX_PARALLEL="${SET_AGENT_PARALLEL:-4}"
SET_AGENT_TIMEOUT_SECONDS="${SET_AGENT_TIMEOUT_SECONDS:-300}"

if ! [[ "$MAX_PARALLEL" =~ ^[0-9]+$ ]] || [ "$MAX_PARALLEL" -lt 1 ]; then
  echo "Error: SET_AGENT_PARALLEL must be a positive integer, got '$MAX_PARALLEL'" >&2
  exit 1
fi
if ! [[ "$SET_AGENT_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]] || [ "$SET_AGENT_TIMEOUT_SECONDS" -lt 1 ]; then
  echo "Error: SET_AGENT_TIMEOUT_SECONDS must be a positive integer, got '$SET_AGENT_TIMEOUT_SECONDS'" >&2
  exit 1
fi

run_set_agent() {
  local task_id="$1"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$SET_AGENT_TIMEOUT_SECONDS" "$REPO_ROOT/run.sh" --headless set agent "$task_id" "$TARGET" >/dev/null 2>&1
  else
    "$REPO_ROOT/run.sh" --headless set agent "$task_id" "$TARGET" >/dev/null 2>&1
  fi
}

while IFS= read -r WF_ID; do
  [ -z "$WF_ID" ] && continue
  WF_IDX=$((WF_IDX + 1))

  TASKS="$(headless query tasks --workflow "$WF_ID" --no-merge --output jsonl | grep '^{' || true)"
  [ -z "$TASKS" ] && continue

  while IFS= read -r TASK_JSON; do
    [ -z "$TASK_JSON" ] && continue

    # AI task: prompt is set in config (exclude command-only tasks)
    if ! echo "$TASK_JSON" | jq -e '.config.prompt != null' >/dev/null; then
      continue
    fi

    TASK_ID="$(echo "$TASK_JSON" | jq -r '.id')"
    DESC="$(echo "$TASK_JSON" | jq -r '.description')"
    CURRENT="$(echo "$TASK_JSON" | jq -r '(.config.executionAgent // "claude")')"

    if [ "$CURRENT" = "$TARGET" ]; then
      SKIPPED=$((SKIPPED + 1))
      continue
    fi

    if [ "$DRY_RUN" = true ]; then
      echo "[dry-run][$WF_IDX/$TOTAL_WF] $TASK_ID: $CURRENT → $TARGET  ($DESC)"
      COUNT=$((COUNT + 1))
      continue
    fi

    echo "[$WF_IDX/$TOTAL_WF] $TASK_ID: $CURRENT → $TARGET  ($DESC)  [queued]"
    run_set_agent "$TASK_ID" &
    DISPATCHED=$((DISPATCHED + 1))
    INFLIGHT=$((INFLIGHT + 1))

    # Keep edits moving: do not wait for a specific task. Reap whichever completes first.
    if [ "$INFLIGHT" -ge "$MAX_PARALLEL" ]; then
      if wait -n; then
        COUNT=$((COUNT + 1))
      else
        FAILED=$((FAILED + 1))
      fi
      INFLIGHT=$((INFLIGHT - 1))
    fi
  done <<< "$TASKS"
done <<< "$WORKFLOWS"

if [ "$DRY_RUN" = false ]; then
  while [ "$INFLIGHT" -gt 0 ]; do
    if wait -n; then
      COUNT=$((COUNT + 1))
    else
      FAILED=$((FAILED + 1))
    fi
    INFLIGHT=$((INFLIGHT - 1))
  done
fi

echo ""
if [ "$DRY_RUN" = true ]; then
  echo "Dry run complete: $COUNT task(s) would change, $SKIPPED already on $TARGET across $TOTAL_WF workflow(s)."
else
  echo "Done: $COUNT task(s) changed to $TARGET, $SKIPPED already on $TARGET, $FAILED failed across $TOTAL_WF workflow(s)."
  echo "Dispatch details: $DISPATCHED queued, max parallel=$MAX_PARALLEL, timeout=${SET_AGENT_TIMEOUT_SECONDS}s"
  if [ "$FAILED" -gt 0 ]; then
    exit 1
  fi
fi
exit 0
