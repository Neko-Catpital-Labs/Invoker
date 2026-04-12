#!/usr/bin/env bash
# Test all fixtures in skills/plan-to-invoker/fixtures/
# Run from repo root: bash skills/plan-to-invoker/scripts/test-fixtures.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VALIDATE_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/validate-plan.sh"
FIXTURES_DIR="$REPO_ROOT/skills/plan-to-invoker/fixtures"
POSITIVE_DIR="$FIXTURES_DIR/positive"
NEGATIVE_DIR="$FIXTURES_DIR/negative"

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

# Generic test for positive fixtures
test_positive_fixture() {
  local fixture_path="$1"
  local fixture_name="$(basename "$fixture_path")"

  local output
  output=$(bash "$VALIDATE_SCRIPT" "$fixture_path" 2>&1)
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo "Expected exit code 0 for $fixture_name, got $exit_code" >&2
    echo "Output: $output" >&2
    return 1
  fi

  # Should output valid JSON with "valid": true
  if ! echo "$output" | grep -q '"valid"[[:space:]]*:[[:space:]]*true'; then
    echo "Expected valid:true in output for $fixture_name, got: $output" >&2
    return 1
  fi

  return 0
}

# Generic test for negative fixtures
test_negative_fixture() {
  local fixture_path="$1"
  local fixture_name="$(basename "$fixture_path")"

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$fixture_path" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for $fixture_name, got 0" >&2
    echo "Output: $output" >&2
    return 1
  fi

  # Should be valid JSON array
  if ! echo "$output" | jq -e 'type == "array"' &>/dev/null; then
    echo "Output is not a valid JSON array for $fixture_name" >&2
    echo "Output: $output" >&2
    return 1
  fi

  # Each error should have errorType and field
  local errors_with_fields
  errors_with_fields=$(echo "$output" | jq '[.[] | select(.errorType and .field)] | length')
  local total_errors
  total_errors=$(echo "$output" | jq 'length')

  if [[ "$errors_with_fields" -ne "$total_errors" ]]; then
    echo "Some errors missing errorType or field in $fixture_name" >&2
    echo "Errors with fields: $errors_with_fields, Total: $total_errors" >&2
    return 1
  fi

  return 0
}

# Specific test for anti-pattern-a (npx vitest run)
test_anti_pattern_a() {
  local fixture="$NEGATIVE_DIR/anti-pattern-a-npx-vitest.yaml"
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$fixture" 2>&1)
  set -e

  # Should contain banned_pattern error
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "banned_pattern")] | length > 0' &>/dev/null; then
    echo "Expected banned_pattern error for anti-pattern-a" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Specific test for anti-pattern-c (both command and prompt)
test_anti_pattern_c() {
  local fixture="$NEGATIVE_DIR/anti-pattern-c-both-command-and-prompt.yaml"
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$fixture" 2>&1)
  set -e

  # Should contain command_prompt_exclusive error
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "command_prompt_exclusive")] | length > 0' &>/dev/null; then
    echo "Expected command_prompt_exclusive error for anti-pattern-c" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Specific test for edge-missing-name
test_edge_missing_name() {
  local fixture="$NEGATIVE_DIR/edge-missing-name.yaml"
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$fixture" 2>&1)
  set -e

  # Should contain missing_required_field error for name
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "missing_required_field" and .field == "name")] | length > 0' &>/dev/null; then
    echo "Expected missing_required_field error for 'name' field" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Specific test for edge-empty-tasks
test_edge_empty_tasks() {
  local fixture="$NEGATIVE_DIR/edge-empty-tasks.yaml"
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$fixture" 2>&1)
  set -e

  # Should contain empty_required_field error for tasks
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "empty_required_field" and .field == "tasks")] | length > 0' &>/dev/null; then
    echo "Expected empty_required_field error for 'tasks' field" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Specific test for edge-invalid-dependency-reference
test_edge_invalid_dependency() {
  local fixture="$NEGATIVE_DIR/edge-invalid-dependency-reference.yaml"
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$fixture" 2>&1)
  set -e

  # Should contain invalid_dependency_reference error
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "invalid_dependency_reference")] | length > 0' &>/dev/null; then
    echo "Expected invalid_dependency_reference error" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Specific test for edge-unrendered-template-placeholder
test_unrendered_template_placeholder() {
  local fixture="$NEGATIVE_DIR/edge-unrendered-template-placeholder.yaml"
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$fixture" 2>&1)
  set -e

  # Should contain unrendered_template_placeholder error
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "unrendered_template_placeholder")] | length > 0' &>/dev/null; then
    echo "Expected unrendered_template_placeholder error" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Specific test for edge-stacked-basebranch-master
test_stacked_basebranch_master() {
  local fixture="$NEGATIVE_DIR/edge-stacked-basebranch-master.yaml"
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$fixture" 2>&1)
  set -e

  # Should contain stacked_basebranch_default error
  if ! echo "$output" | jq -e '[.[] | select(.errorType == "stacked_basebranch_default")] | length > 0' &>/dev/null; then
    echo "Expected stacked_basebranch_default error" >&2
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

if [[ ! -d "$POSITIVE_DIR" ]]; then
  fail "Positive fixtures directory not found: $POSITIVE_DIR"
fi

if [[ ! -d "$NEGATIVE_DIR" ]]; then
  fail "Negative fixtures directory not found: $NEGATIVE_DIR"
fi

echo "========================================="
echo "Testing positive fixtures"
echo "========================================="

# Test all positive fixtures
for fixture in "$POSITIVE_DIR"/*.yaml; do
  if [[ -f "$fixture" ]]; then
    run_test "Positive: $(basename "$fixture")" test_positive_fixture "$fixture"
  fi
done

echo ""
echo "========================================="
echo "Testing negative fixtures (generic)"
echo "========================================="

# Test all negative fixtures (generic validation)
for fixture in "$NEGATIVE_DIR"/*.yaml; do
  if [[ -f "$fixture" ]]; then
    run_test "Negative: $(basename "$fixture")" test_negative_fixture "$fixture"
  fi
done

echo ""
echo "========================================="
echo "Testing specific error types"
echo "========================================="

# Run specific error type tests
run_test "Anti-pattern A: banned_pattern for npx vitest run" test_anti_pattern_a
run_test "Anti-pattern C: command_prompt_exclusive" test_anti_pattern_c
run_test "Edge: missing_required_field for name" test_edge_missing_name
run_test "Edge: empty_required_field for tasks" test_edge_empty_tasks
run_test "Edge: invalid_dependency_reference" test_edge_invalid_dependency
run_test "Edge: unrendered_template_placeholder" test_unrendered_template_placeholder
run_test "Edge: stacked_basebranch_default" test_stacked_basebranch_master

echo ""
echo "========================================="
echo "Fixture tests: $pass_count/$test_count passed"
echo "========================================="

if [[ $pass_count -eq $test_count ]]; then
  echo "✓ All fixture tests passed"
  exit 0
else
  fail "Some fixture tests failed"
fi
