#!/usr/bin/env bash
# Extract assumptions from a plan file (markdown or free text) as JSON.
# Usage: bash extract-assumptions.sh <plan-file>
#    or: cat plan.md | bash extract-assumptions.sh
set -euo pipefail

if [[ $# -ge 1 && -f "$1" ]]; then
  input=$(cat "$1")
else
  input=$(cat)
fi

# Strip backticks and markdown formatting so paths inside `...` are visible
cleaned=$(echo "$input" | sed 's/`//g')

# Extract file paths (packages/... or src/... ending in known extensions)
files=$(echo "$cleaned" | grep -oE '(packages|src)/[A-Za-z0-9_./_-]+\.(ts|tsx|js|jsx|json|yaml|yml|sh|md)' | sort -u || true)

# Extract test files specifically
tests=$(echo "$files" | grep -E '\.test\.(ts|tsx|js|jsx)$' || true)

# Extract function/class/export names from backtick-quoted identifiers in original input
functions=$(echo "$input" | grep -oE '`[A-Za-z][A-Za-z0-9_]*`' | tr -d '`' | sort -u || true)

# Extract package names from packages/<name> paths
packages=$(echo "$cleaned" | grep -oE 'packages/[a-zA-Z0-9_-]+' | sed 's|packages/||' | sort -u || true)

# Build pattern checks: for each function mentioned alongside a file, create a grep pattern
patterns="[]"
if command -v jq &>/dev/null; then
  pattern_array="[]"
  while IFS= read -r func; do
    [[ -z "$func" ]] && continue
    # Find files mentioned near this function (within 3 lines)
    # grep may return 1 on no matches (or SIGPIPE from head) — tolerate it under set -e
    associated_files=$(echo "$cleaned" | grep -B2 -A2 -F -- "$func" 2>/dev/null | grep -oE '(packages|src)/[A-Za-z0-9_./_-]+\.(ts|tsx|js|jsx)' 2>/dev/null | head -3 || true)
    while IFS= read -r afile; do
      [[ -z "$afile" ]] && continue
      pattern_array=$(echo "$pattern_array" | jq --arg p "$func" --arg f "$afile" '. + [{"pattern": $p, "file": $f}]')
    done <<< "$associated_files"
  done <<< "$functions"
  patterns="$pattern_array"
fi

# Assemble JSON output
if command -v jq &>/dev/null; then
  jq -n \
    --argjson files "$(echo "$files" | jq -R -s 'split("\n") | map(select(length > 0))')" \
    --argjson tests "$(echo "$tests" | jq -R -s 'split("\n") | map(select(length > 0))')" \
    --argjson functions "$(echo "$functions" | jq -R -s 'split("\n") | map(select(length > 0))')" \
    --argjson packages "$(echo "$packages" | jq -R -s 'split("\n") | map(select(length > 0))')" \
    --argjson patterns "$patterns" \
    '{files: $files, tests: $tests, functions: $functions, packages: $packages, patterns: $patterns}'
else
  # Fallback: raw JSON without jq
  to_json_array() {
    local first=true
    echo -n "["
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      $first || echo -n ","
      first=false
      echo -n "\"$line\""
    done
    echo -n "]"
  }
  echo -n '{"files":'
  echo "$files" | to_json_array
  echo -n ',"tests":'
  echo "$tests" | to_json_array
  echo -n ',"functions":'
  echo "$functions" | to_json_array
  echo -n ',"packages":'
  echo "$packages" | to_json_array
  echo -n ',"patterns":[]}'
  echo
fi
