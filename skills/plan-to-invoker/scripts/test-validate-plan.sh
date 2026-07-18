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
    'invalid_field_type:poolId'
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
    "invalid_field_type"
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

# Test: pnpm commands must start with pnpm install
test_pnpm_without_install() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: test-plan
repoUrl: git@github.com:user/repo.git
tasks:
  - id: task-missing-install
    description: Task using pnpm without install
    command: cd packages/app && pnpm test
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  set -e

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "banned_pattern" and .taskId == "task-missing-install")] | length > 0' &>/dev/null; then
    echo "Expected banned_pattern error for task-missing-install" >&2
    echo "Output: $output" >&2
    return 1
  fi
  if ! echo "$output" | grep -q 'leading pnpm install'; then
    echo "Expected leading pnpm install message" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

test_pnpm_with_install_validates() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: test-plan
onFinish: none
mergeMode: manual
repoUrl: git@github.com:user/repo.git
tasks:
  - id: task-with-install
    description: Task using pnpm after install
    command: pnpm install --frozen-lockfile && cd packages/app && pnpm test
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -ne 0 ]]; then
    echo "Expected exit code 0, got $exit_code" >&2
    echo "Output: $output" >&2
    return 1
  fi
  if ! echo "$output" | grep -q '"valid"[[:space:]]*:[[:space:]]*true'; then
    echo "Expected valid:true in output, got: $output" >&2
    return 1
  fi

  return 0
}

# Test: nested shell command strings must not use shell variables
test_nested_shell_variable_expansion_fails() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: nested-shell-variable-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: unsafe-smoke
    description: Exact failed nightly command
    command: >-
      sh -c "value='Supported: deterministic command-only smoke'; printf '%s\n' \"$value\"; test \"$value\" = 'Supported: deterministic command-only smoke'"
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for nested shell variable command" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "unsafe_shell_variable_expansion" and .field == "command" and .taskId == "unsafe-smoke")] | length == 1' &>/dev/null; then
    echo "Expected unsafe_shell_variable_expansion for unsafe-smoke command" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: simple literal command-only smoke plans should still validate
test_literal_smoke_command_validates() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: literal-smoke-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: literal-smoke
    description: Literal smoke command
    command: "printf '%s\n' 'Supported: deterministic command-only smoke' && test 1 -eq 1"
EOF

  local output
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo "Expected exit code 0, got $exit_code" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | grep -q '"valid"[[:space:]]*:[[:space:]]*true'; then
    echo "Expected valid:true in output, got: $output" >&2
    return 1
  fi

  return 0
}

# Test: direct shell variables remain valid when no nested sh -c/bash -c is used
test_direct_shell_variable_command_validates() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: direct-shell-variable-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: direct-variable
    description: Direct shell variable command
    command: >-
      value=ok; printf '%s\n' "$value"
EOF

  local output
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo "Expected exit code 0, got $exit_code" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: command tasks using pipefail must explicitly run through bash
test_pipefail_without_bash_fails() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: pipefail-portability-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: unsafe-pipefail
    description: Command uses bash-only pipefail under the default shell
    command: |
      set -euo pipefail
      echo ok | tee /tmp/invoker-pipefail-proof
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for pipefail command without bash" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "non_portable_pipefail" and .field == "command" and .taskId == "unsafe-pipefail")] | length == 1' &>/dev/null; then
    echo "Expected non_portable_pipefail for unsafe-pipefail command" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: bash-wrapped pipefail commands remain valid
test_pipefail_with_bash_validates() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: pipefail-bash-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: bash-pipefail
    description: Command explicitly runs bash for pipefail support
    command: >-
      bash -lc 'set -euo pipefail; echo ok | tee /tmp/invoker-pipefail-proof'
EOF

  local output
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo "Expected exit code 0, got $exit_code" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | grep -q '"valid"[[:space:]]*:[[:space:]]*true'; then
    echo "Expected valid:true in output, got: $output" >&2
    return 1
  fi

  return 0
}

# Test: experiment variant commands use the same nested shell guard
test_experiment_variant_nested_shell_variable_expansion_fails() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: experiment-variant-shell-variable-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: experiment-task
    description: Experiment variant with unsafe command
    prompt: "Compare variants"
    experimentVariants:
      - name: unsafe
        command: >-
          bash -lc "value='variant'; printf '%s\n' \"$value\""
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for unsafe experiment variant command" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "unsafe_shell_variable_expansion" and .field == "experimentVariants[0].command" and .taskId == "experiment-task")] | length == 1' &>/dev/null; then
    echo "Expected unsafe_shell_variable_expansion for experiment variant command" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: command tasks must not reference missing shell scripts
test_missing_command_script_fails() {
  local temp_plan script_path
  temp_plan=$(mktemp)
  script_path="scripts/repro/repro-plan-validator-missing-local-$$.sh"
  rm -f "$REPO_ROOT/$script_path"
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<EOF
name: missing-command-script-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: repro-proof
    description: Repro proof references a script that is not checked out
    command: "bash \${PWD}/$script_path"
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for missing command script" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "missing_file_reference" and .field == "command" and .taskId == "repro-proof")] | length == 1' &>/dev/null; then
    echo "Expected missing_file_reference for repro-proof command" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: bare relative shell scripts must be checked into HEAD
test_missing_bare_command_script_fails() {
  local temp_plan script_path
  temp_plan=$(mktemp)
  script_path="./repro-plan-validator-missing-bare-$$.sh"
  rm -f "$REPO_ROOT/${script_path#./}"
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<EOF
name: missing-bare-command-script-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: bare-repro-proof
    description: Repro proof references a bare script that is not checked out
    command: "bash $script_path"
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for missing bare command script" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "missing_file_reference" and .field == "command" and .taskId == "bare-repro-proof")] | length == 1' &>/dev/null; then
    echo "Expected missing_file_reference for bare-repro-proof command" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}


# Test: command tasks must not reference local files that are not checked into HEAD
test_local_only_command_file_fails() {
  local temp_plan local_path abs_local
  temp_plan=$(mktemp)
  local_path="docs/context/plan-validator-local-only-$$.txt"
  abs_local="$REPO_ROOT/$local_path"
  trap "rm -f $temp_plan $abs_local" RETURN

  mkdir -p "$REPO_ROOT/docs/context"
  printf 'local only\n' > "$abs_local"

  cat > "$temp_plan" <<EOF
name: local-only-command-file-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: repro-proof
    description: Repro proof references a local-only command input
    command: "node scripts/read-fixture.mjs --fixture=$local_path"
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for local-only command file" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "local_only_file_reference" and .field == "command" and .taskId == "repro-proof")] | length == 1' &>/dev/null; then
    echo "Expected local_only_file_reference for repro-proof command" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: bare relative local shell scripts must not be treated as checked in
test_local_only_bare_command_script_fails() {
  local temp_plan script_path abs_local
  temp_plan=$(mktemp)
  script_path="repro-plan-validator-local-only-bare-$$.sh"
  abs_local="$REPO_ROOT/$script_path"
  trap "rm -f $temp_plan $abs_local" RETURN

  printf '#!/usr/bin/env bash\nexit 0\n' > "$abs_local"

  cat > "$temp_plan" <<EOF
name: local-only-bare-command-script-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: bare-repro-proof
    description: Repro proof references a local-only bare command script
    command: "bash $script_path"
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for local-only bare command script" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "local_only_file_reference" and .field == "command" and .taskId == "bare-repro-proof")] | length == 1' &>/dev/null; then
    echo "Expected local_only_file_reference for bare-repro-proof command" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}


# Test: prompt tasks must not reference local-only files either
test_local_only_prompt_file_fails() {
  local temp_plan local_path abs_local
  temp_plan=$(mktemp)
  local_path="docs/context/plan-validator-local-only-prompt-$$.md"
  abs_local="$REPO_ROOT/$local_path"
  trap "rm -f $temp_plan $abs_local" RETURN

  mkdir -p "$REPO_ROOT/docs/context"
  printf 'local only\n' > "$abs_local"

  cat > "$temp_plan" <<EOF
name: local-only-prompt-file-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: implementation-proof
    description: Review docs/context/plan-validator-local-only-prompt-$$.md before changing code
    prompt: |
      Use $local_path as the implementation brief.
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for local-only prompt file" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "local_only_file_reference" and .field == "prompt" and .taskId == "implementation-proof")] | length == 1' &>/dev/null; then
    echo "Expected local_only_file_reference for implementation-proof prompt" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: experiment variant command files are validated
test_experiment_variant_missing_command_script_fails() {
  local temp_plan script_path
  temp_plan=$(mktemp)
  script_path="scripts/repro/repro-plan-validator-missing-variant-$$.sh"
  rm -f "$REPO_ROOT/$script_path"
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<EOF
name: missing-variant-command-script-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: experiment-proof
    description: Repro proof variant references a script that is not checked out
    command: "printf 'base\\n'"
    experimentVariants:
      - id: variant-a
        command: "bash $script_path"
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for missing variant command script" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "missing_file_reference" and .field == "experimentVariants[0].command" and .taskId == "experiment-proof")] | length == 1' &>/dev/null; then
    echo "Expected missing_file_reference for experiment variant command" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

# Test: upward relative paths are not valid plan file references
test_upward_relative_path_fails() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: upward-relative-path-test
repoUrl: git@github.com:user/repo.git
onFinish: none
tasks:
  - id: repro-proof
    description: Verify a file outside the checkout
    command: "bash ../../../scripts/repro/local-only.sh && node scripts/../docs/context/local-only.txt"
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for upward relative path" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '
    [.[] | select(.errorType == "unsupported_relative_file_reference" and .field == "command" and .taskId == "repro-proof")] as $errors |
    ($errors | length) == 2 and
    any($errors[]; .message | contains("../../../scripts/repro/local-only.sh")) and
    any($errors[]; .message | contains("scripts/../docs/context/local-only.txt"))
  ' &>/dev/null; then
    echo "Expected unsupported_relative_file_reference for both parent-directory command paths" >&2
    echo "Output: $output" >&2
    return 1
  fi
  return 0
}


# Test: Branched review-gate artifacts should fail validation
test_branched_review_gate_rejected() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: branched-review-gate
onFinish: none
mergeMode: manual
repoUrl: git@github.com:user/repo.git
tasks:
  - id: verify-review-gate
    description: Verify review gate metadata
    command: printf 'ok\n'
    dependencies: []
reviewGate:
  artifacts:
    - id: contracts
      title: Contracts
      required: true
    - id: runtime
      title: Runtime
      required: true
      dependsOn: [contracts]
    - id: ui
      title: UI
      required: true
      dependsOn: [contracts]
EOF

  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code for branched review-gate artifacts" >&2
    echo "Output: $output" >&2
    return 1
  fi

  if ! echo "$output" | jq -e '
    length == 1 and (
      .[0].errorType == "invalid_dependency_reference" and
      .[0].field == "reviewGate.artifacts[2].dependsOn" and
      .[0].message == "reviewGate.artifacts[2].dependsOn must be [\"runtime\"] to keep the review-gate stack linear"
    )
  ' &>/dev/null; then
    echo "Expected linear review-gate dependency error for reviewGate.artifacts[2].dependsOn" >&2
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
run_test "pnpm without leading install should be detected" test_pnpm_without_install
run_test "pnpm with leading install should validate" test_pnpm_with_install_validates
run_test "Nested shell variable expansion should be rejected" test_nested_shell_variable_expansion_fails
run_test "Literal smoke command should validate" test_literal_smoke_command_validates
run_test "Direct shell variable command should validate" test_direct_shell_variable_command_validates
run_test "Pipefail without bash should be rejected" test_pipefail_without_bash_fails
run_test "Pipefail with bash should validate" test_pipefail_with_bash_validates
run_test "Experiment variant nested shell variable expansion should be rejected" test_experiment_variant_nested_shell_variable_expansion_fails
run_test "Missing command scripts should be rejected" test_missing_command_script_fails
run_test "Missing bare command scripts should be rejected" test_missing_bare_command_script_fails
run_test "Local-only command files should be rejected" test_local_only_command_file_fails
run_test "Local-only bare command scripts should be rejected" test_local_only_bare_command_script_fails
run_test "Local-only prompt files should be rejected" test_local_only_prompt_file_fails
run_test "Upward relative paths should be rejected" test_upward_relative_path_fails
run_test "Experiment variant missing command scripts should be rejected" test_experiment_variant_missing_command_script_fails
run_test "Branched review gate artifacts should be rejected" test_branched_review_gate_rejected
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

