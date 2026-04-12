#!/usr/bin/env bash
# Parse Invoker submit-plan.sh output into structured JSON.
# Usage: bash parse-results.sh < /tmp/invoker-verify.txt
set -euo pipefail

input=$(cat)

total=0
passed=0
failed=0

# Temp file for task results
tmp_tasks=$(mktemp)
trap 'rm -f "$tmp_tasks"' EXIT

# Parse lines looking for task status patterns from Invoker output
while IFS= read -r line; do
  tid=""
  status=""

  # Pattern: [task-id] completed/failed/status
  if [[ "$line" =~ \[([a-zA-Z0-9_-]+)\][[:space:]]*(completed|failed|errored|cancelled) ]]; then
    tid="${BASH_REMATCH[1]}"
    status="${BASH_REMATCH[2]}"
  # Pattern: task "task-id" completed/failed
  elif [[ "$line" =~ task[[:space:]]+\"?([a-zA-Z0-9_-]+)\"?[[:space:]]+(completed|failed|errored|cancelled) ]]; then
    tid="${BASH_REMATCH[1]}"
    status="${BASH_REMATCH[2]}"
  # Pattern: ✓ task-id or ✗ task-id or PASS/FAIL task-id
  elif [[ "$line" =~ (PASS|FAIL)[[:space:]]+([a-zA-Z0-9_-]+) ]]; then
    tid="${BASH_REMATCH[2]}"
    if [[ "${BASH_REMATCH[1]}" == "PASS" ]]; then
      status="completed"
    else
      status="failed"
    fi
  fi

  if [[ -n "$tid" && -n "$status" ]]; then
    # Avoid duplicate task entries
    if ! grep -q "^${tid}|" "$tmp_tasks" 2>/dev/null; then
      echo "${tid}|${status}" >> "$tmp_tasks"
      total=$((total + 1))
      if [[ "$status" == "completed" ]]; then
        passed=$((passed + 1))
      else
        failed=$((failed + 1))
      fi
    fi
  fi
done <<< "$input"

# Generate JSON output
if command -v jq &>/dev/null; then
  tasks_json="{}"
  while IFS='|' read -r tid status; do
    [[ -z "$tid" ]] && continue
    tasks_json=$(echo "$tasks_json" | jq \
      --arg id "$tid" \
      --arg status "$status" \
      '. + {($id): {status: $status}}')
  done < "$tmp_tasks"

  jq -n \
    --argjson tasks "$tasks_json" \
    --argjson total "$total" \
    --argjson passed "$passed" \
    --argjson failed "$failed" \
    '{tasks: $tasks, summary: {total: $total, passed: $passed, failed: $failed}}'
else
  # Fallback without jq
  echo -n '{"tasks":{'
  first=true
  while IFS='|' read -r tid status; do
    [[ -z "$tid" ]] && continue
    $first || echo -n ","
    first=false
    echo -n "\"$tid\":{\"status\":\"$status\"}"
  done < "$tmp_tasks"
  echo -n "},"
  echo "\"summary\":{\"total\":$total,\"passed\":$passed,\"failed\":$failed}}"
fi
