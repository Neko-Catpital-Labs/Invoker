#!/usr/bin/env bash
# Regression tests for the typed plan validator
# Run from repo root: bash skills/plan-to-invoker/scripts/test-validate-plan.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VALIDATE_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/validate-plan.sh"
POSITIVE_FIXTURE="$REPO_ROOT/plans/plan-to-invoker-deterministic-step-1-validator.yaml"
NEGATIVE_FIXTURE="$REPO_ROOT/plans/plan-to-invoker-deterministic-step-1-validator-negative.yaml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test_count=0
pass_count=0

run_test() {
  local test_name="$1"
  shift
  test_count=$((test_count + 1))
  echo "Running test: $test_name"
  if "$@"; then
    pass_count=$((pass_count + 1))
    echo "  ✓ PASS"
  else
    echo "  ✗ FAIL: $test_name"
    fail "$test_name failed"
  fi
}

# Test: positive fixture should pass validation
test_positive_fixture() {
  local output
  output=$(bash "$VALIDATE_SCRIPT" "$POSITIVE_FIXTURE" 2>&1)
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo "Expected exit code 0, got $exit_code" >&2
    echo "Output: $output" >&2
    return 1
  fi

  # Should output valid JSON with "valid": true
  if ! echo "$output" | grep -q '"valid"[[:space:]]*:[[:space:]]*true'; then
    echo "Expected valid:true in output, got: $output" >&2
    return 1
  fi

  return 0
}

# Test: negative fixture should fail with non-zero exit code
test_negative_fixture_fails() {
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$NEGATIVE_FIXTURE" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code, got 0" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: negative fixture should produce deterministic error keys
test_negative_fixture_error_keys() {
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$NEGATIVE_FIXTURE" 2>&1)
  set -e

  # Check for required error types and fields using jq
  local required_checks=(
    'missing_required_field:name'
    'missing_required_field:repoUrl'
    'missing_required_field:description'
    'invalid_enum_value:mergeMode'
    'missing_required_field:id'
    'command_prompt_exclusive:command|prompt'
    'missing_command_or_prompt:command|prompt'
    'invalid_enum_value:executorType'
    'banned_pattern:command'
    'invalid_dependency_reference:dependencies'
    'invalid_enum_value:externalDependencies[0].requiredStatus'
    'invalid_enum_value:externalDependencies[0].gatePolicy'
  )

  for check in "${required_checks[@]}"; do
    local error_type="${check%%:*}"
    local field="${check#*:}"

    if ! echo "$output" | jq -e --arg et "$error_type" --arg f "$field" \
      '[.[] | select(.errorType == $et and .field == $f)] | length > 0' &>/dev/null; then
      echo "Missing expected error: errorType=$error_type, field=$field" >&2
      echo "Output: $output" >&2
      return 1
    fi
  done

  return 0
}

# Test: negative fixture should produce JSON array structure
test_negative_fixture_json_structure() {
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$NEGATIVE_FIXTURE" 2>&1)
  set -e

  # Should be valid JSON array
  if ! echo "$output" | jq -e 'type == "array"' &>/dev/null; then
    echo "Output is not a valid JSON array" >&2
    echo "Output: $output" >&2
    return 1
  fi

  # Each error should have errorType and field
  local errors_with_fields
  errors_with_fields=$(echo "$output" | jq '[.[] | select(.errorType and .field)] | length')
  local total_errors
  total_errors=$(echo "$output" | jq 'length')

  if [[ "$errors_with_fields" -ne "$total_errors" ]]; then
    echo "Some errors missing errorType or field" >&2
    echo "Errors with fields: $errors_with_fields, Total: $total_errors" >&2
    return 1
  fi

  return 0
}

# Test: negative fixture should contain specific error types
test_negative_fixture_specific_errors() {
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$NEGATIVE_FIXTURE" 2>&1)
  set -e

  # Check for specific errorType values (deterministic keys)
  local error_types=(
    "missing_required_field"
    "invalid_enum_value"
    "command_prompt_exclusive"
    "missing_command_or_prompt"
    "banned_pattern"
    "invalid_dependency_reference"
  )

  for error_type in "${error_types[@]}"; do
    if ! echo "$output" | jq -e --arg et "$error_type" '[.[] | select(.errorType == $et)] | length > 0' &>/dev/null; then
      echo "Missing expected errorType: $error_type" >&2
      echo "Output: $output" >&2
      return 1
    fi
  done

  return 0
}

# Test: Create a minimal invalid plan and check error output
test_minimal_invalid_plan() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
# Minimal invalid plan - missing required fields
tasks: []
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for minimal invalid plan" >&2
    return 1
  fi

  # Should report missing name and repoUrl
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "missing_required_field" and .field == "name")] | length > 0' &>/dev/null; then
    echo "Expected missing_required_field error for 'name'" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "missing_required_field" and .field == "repoUrl")] | length > 0' &>/dev/null; then
    echo "Expected missing_required_field error for 'repoUrl'" >&2
    echo "Output: $output" >&2
    return 1
  fi

  # Should report empty tasks array
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "empty_required_field" and .field == "tasks")] | length > 0' &>/dev/null; then
    echo "Expected empty_required_field error for 'tasks'" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: Create a plan with command+prompt conflict
test_command_prompt_conflict() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: test-plan
repoUrl: git@github.com:user/repo.git
tasks:
  - id: conflicting-task
    description: This task has both command and prompt
    command: echo "test"
    prompt: "Also has a prompt"
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  set -e

  # Should contain command_prompt_exclusive error
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "command_prompt_exclusive" and .taskId == "conflicting-task")] | length > 0' &>/dev/null; then
    echo "Expected command_prompt_exclusive error for conflicting-task" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: Create a plan with invalid dependency
test_invalid_dependency() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: test-plan
repoUrl: git@github.com:user/repo.git
tasks:
  - id: task-a
    description: First task
    command: echo "a"
  - id: task-b
    description: Second task with invalid dependency
    command: echo "b"
    dependencies:
      - non-existent-task
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  set -e

  # Should contain invalid_dependency_reference error
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "invalid_dependency_reference" and .taskId == "task-b")] | length > 0' &>/dev/null; then
    echo "Expected invalid_dependency_reference error for task-b" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: Create a plan with banned pattern (npx vitest run)
test_banned_pattern() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: test-plan
repoUrl: git@github.com:user/repo.git
tasks:
  - id: task-with-banned-cmd
    description: Task using banned npx vitest run
    command: cd packages/app && npx vitest run
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  set -e

  # Should contain banned_pattern error
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "banned_pattern" and .taskId == "task-with-banned-cmd")] | length > 0' &>/dev/null; then
    echo "Expected banned_pattern error for task-with-banned-cmd" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: Verify error has required fields with correct types
test_error_field_structure() {
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$NEGATIVE_FIXTURE" 2>&1)
  set -e

  # Every error should have errorType (string), field (string), message (string)
  # Some may have taskId (string) and value (any)
  if ! echo "$output" | jq -e '
    [.[] |
      select(
        (.errorType | type) == "string" and
        (.field | type) == "string" and
        (.message | type) == "string" and
        (if .taskId then (.taskId | type) == "string" else true end)
      )
    ] | length == (. | length)
  ' &>/dev/null; then
    echo "Some errors have incorrect field types" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Check dependencies
if ! command -v jq &>/dev/null; then
  fail "jq is required for JSON parsing tests"
fi

if [[ ! -f "$VALIDATE_SCRIPT" ]]; then
  fail "Validator script not found: $VALIDATE_SCRIPT"
fi

if [[ ! -f "$POSITIVE_FIXTURE" ]]; then
  fail "Positive fixture not found: $POSITIVE_FIXTURE"
fi

if [[ ! -f "$NEGATIVE_FIXTURE" ]]; then
  fail "Negative fixture not found: $NEGATIVE_FIXTURE"
fi

# Run all tests
run_test "Positive fixture should pass validation" test_positive_fixture
run_test "Negative fixture should fail with non-zero exit" test_negative_fixture_fails
run_test "Negative fixture should produce deterministic error keys" test_negative_fixture_error_keys
run_test "Negative fixture should produce JSON array structure" test_negative_fixture_json_structure
run_test "Negative fixture should contain specific error types" test_negative_fixture_specific_errors
run_test "Minimal invalid plan should report missing fields" test_minimal_invalid_plan
run_test "Command+prompt conflict should be detected" test_command_prompt_conflict
run_test "Invalid dependency should be detected" test_invalid_dependency
run_test "Banned pattern (npx vitest run) should be detected" test_banned_pattern
run_test "Error objects should have correct field structure" test_error_field_structure

echo ""
echo "========================================="
echo "Validator tests: $pass_count/$test_count passed"
echo "========================================="

if [[ $pass_count -eq $test_count ]]; then
  echo "✓ All validator tests passed"
  exit 0
else
  fail "Some validator tests failed"
fi
