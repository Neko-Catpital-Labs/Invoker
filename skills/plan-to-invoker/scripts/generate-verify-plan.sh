#!/usr/bin/env bash
# Generate a verification YAML plan from assumptions JSON.
# Usage: bash generate-verify-plan.sh "<plan-name>" < assumptions.json > verify.yaml
set -euo pipefail

plan_name="${1:?Usage: generate-verify-plan.sh <plan-name>}"
slug=$(echo "$plan_name" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')

# Read assumptions from stdin
assumptions=$(cat)

# Start YAML output
cat <<EOF
name: "Verify: ${plan_name}"
onFinish: none

tasks:
EOF

task_count=0

json_escape_for_double_quotes() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# Generate file-existence checks
if command -v jq &>/dev/null; then
  files=$(echo "$assumptions" | jq -r '.files[]' 2>/dev/null || true)
else
  files=$(echo "$assumptions" | grep -oE '"(packages|src)/[^"]*"' | tr -d '"' || true)
fi

while IFS= read -r filepath; do
  [[ -z "$filepath" ]] && continue
  task_id="verify-file-$(echo "$filepath" | sed 's|[/.]|-|g; s/--*/-/g')"
  cat <<EOF
  - id: ${task_id}
    description: "Verify file exists: ${filepath}"
    command: "test -f ${filepath}"
    dependencies: []

EOF
  task_count=$((task_count + 1))
done <<< "$files"

# Generate pattern-in-file checks
if command -v jq &>/dev/null; then
  pattern_count=$(echo "$assumptions" | jq '.patterns | length' 2>/dev/null || echo 0)
  for ((i = 0; i < pattern_count; i++)); do
    pattern=$(echo "$assumptions" | jq -r ".patterns[$i].pattern")
    file=$(echo "$assumptions" | jq -r ".patterns[$i].file")
    task_id="verify-pattern-$(echo "${pattern}-${file}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g; s/--*/-/g; s/^-//; s/-$//')"
    cat <<EOF
  - id: ${task_id}
    description: "Verify '${pattern}' exists in ${file}"
    command: "grep -q '${pattern}' ${file}"
    dependencies: []

EOF
    task_count=$((task_count + 1))
  done
fi

# Generate package test checks
if command -v jq &>/dev/null; then
  pkgs=$(echo "$assumptions" | jq -r '.packages[]' 2>/dev/null || true)
else
  pkgs=$(echo "$assumptions" | grep -oE '"[a-zA-Z0-9_-]+"' | tr -d '"' | sort -u || true)
fi

while IFS= read -r pkg; do
  [[ -z "$pkg" ]] && continue
  # Only generate test task if packages/<pkg> directory exists reference
  task_id="verify-tests-${pkg}"
  cat <<EOF
  - id: ${task_id}
    description: "Verify tests pass for package: ${pkg}"
    command: "cd packages/${pkg} && pnpm test"
    dependencies: []

EOF
  task_count=$((task_count + 1))
done <<< "$pkgs"

# Generate policy coverage checks when coverageItems exist
if command -v jq &>/dev/null; then
  source_kind=$(echo "$assumptions" | jq -r '.sourceKind // "generic"' 2>/dev/null || echo "generic")
  source_file=$(echo "$assumptions" | jq -r '.sourceFile // empty' 2>/dev/null || true)
  if [[ "$source_kind" == "policy_matrix" && -n "$source_file" ]]; then
    coverage_count=$(echo "$assumptions" | jq '.coverageItems | length' 2>/dev/null || echo 0)
    for ((i = 0; i < coverage_count; i++)); do
      coverage_key=$(echo "$assumptions" | jq -r ".coverageItems[$i].coverageKey")
      verify_text=$(echo "$assumptions" | jq -r ".coverageItems[$i].verifyText")
      safe_text=$(json_escape_for_double_quotes "$verify_text")
      task_id="verify-coverage-$(echo "$coverage_key" | sed 's|[/.]|-|g; s/--*/-/g')"
      cat <<EOF
  - id: ${task_id}
    description: "Verify policy coverage source exists: ${coverage_key}"
    command: "grep -qF -- \"${safe_text}\" \"${source_file}\""
    dependencies: []

EOF
      task_count=$((task_count + 1))
    done
  fi
fi

# If no tasks were generated, add a no-op so the plan is valid
if [[ $task_count -eq 0 ]]; then
  cat <<EOF
  - id: verify-noop
    description: "No assumptions to verify"
    command: "echo 'No assumptions extracted — nothing to verify'"
    dependencies: []
EOF
fi
