#!/usr/bin/env bash
# Test all fixtures in skills/plan-to-invoker/fixtures/
# Run from repo root: bash skills/plan-to-invoker/scripts/test-fixtures.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VALIDATE_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/validate-plan.sh"
FIXTURES_DIR="$REPO_ROOT/skills/plan-to-invoker/fixtures"
POSITIVE_DIR="$FIXTURES_DIR/positive"
NEGATIVE_DIR="$FIXTURES_DIR/negative"
LINT_SCRIPT="$REPO_ROOT/skills/plan-to-invoker/scripts/lint-task-atomicity.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test_count=0
pass_count=0
DOCTOR_NEGATIVE_FIXTURES=(
  "anti-pattern-g-monolithic-prompt-edit-bridge.yaml"
  "anti-pattern-h-layer-order-violation.yaml"
  "anti-pattern-j-zero-context-missing-metadata.yaml"
  "anti-pattern-k-missing-review-compression.yaml"
  "anti-pattern-l-behavior-plus-proof.yaml"
  "anti-pattern-m-refactor-plus-fields.yaml"
  "anti-pattern-n-broad-autofix-policy-review-unit.yaml"
  "anti-pattern-o-all-in-one-autofix-review-unit.yaml"
)

is_doctor_negative_fixture() {
  local fixture_name="$1"
  for candidate in "${DOCTOR_NEGATIVE_FIXTURES[@]}"; do
    if [[ "$fixture_name" == "$candidate" ]]; then
      return 0
    fi
  done
  return 1
}

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

test_doctor_negative_fixture() {
  local fixture_path="$1"
  local fixture_name="$(basename "$fixture_path")"
  local expected_failed_step="lint-task-atomicity"
  local output
  local stderr_file
  stderr_file="$(mktemp)"

  set +e
  output=$(bash "$REPO_ROOT/skills/plan-to-invoker/scripts/skill-doctor.sh" "$fixture_path" 2>"$stderr_file")
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected non-zero exit code from skill-doctor for $fixture_name, got 0" >&2
    echo "Output: $output" >&2
    echo "Errors: $(cat "$stderr_file")" >&2
    rm -f "$stderr_file"
    return 1
  fi

  if ! echo "$output" | jq -e --arg expected "$expected_failed_step" '.allPassed == false and .firstFailedStep == $expected' &>/dev/null; then
    echo "Expected firstFailedStep=$expected_failed_step for $fixture_name" >&2
    echo "Output: $output" >&2
    echo "Errors: $(cat "$stderr_file")" >&2
    rm -f "$stderr_file"
    return 1
  fi

  rm -f "$stderr_file"
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

test_runner_kind_is_unsupported() {
  local fixture="$NEGATIVE_DIR/edge-invalid-executor-type.yaml"
  local output
  set +e
  output=$(bash "$VALIDATE_SCRIPT" "$fixture" 2>&1)
  set -e

  if ! echo "$output" | jq -e '[.[] | select(.errorType == "unsupported_field" and .field == "runnerKind")] | length > 0' &>/dev/null; then
    echo "Expected unsupported_field error for runnerKind" >&2
    echo "Output: $output" >&2
    return 1
  fi

  return 0
}

test_lint_allows_focused_verification_without_test_all() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: "Valid focused verification gate"
description: |
  Implementation plan with focused terminal verification.
  Standalone workflow waiver:
  - This fixture intentionally keeps one behavior prompt and one proof prompt in a single workflow so focused verification can be validated in one place.
onFinish: pull_request
mergeMode: external_review
repoUrl: git@github.com:example-org/acme-repo.git
tasks:
  - id: implement-surface
    description: |
      Review claim:
      - Implement contact-surface wiring updates in a typed and deterministic way.
      Review lane:
      - behavior
      Safety invariant:
      - The change stays inside the contact surface and directly affected tests.
      Slice rationale:
      - Behavior lands before proof and cleanup.
      Architectural effect:
      - The contact-surface path gains the new wiring without changing unrelated layers.
      Goal:
      - Implement contact-surface wiring updates in a typed and deterministic way.
      Motivation:
      - Keep task execution intent explicit for delegated AI execution.
      Alternative considerations:
      - Option A (chosen): direct contact-surface wiring.
      - Option B: defer via adapter layer.
      Implementation details:
      - Modify packages/foo/src/surface.ts and preserve existing contract imports.
      Non-goals:
      - Do not add regression proof in this slice.
      Feature: contact_surface
      Feature state: active
      Files:
      - packages/foo/src/surface.ts
      Change types:
      - packages/foo/src/surface.ts: modify
      Acceptance criteria:
      - Ensure the new surface compiles and keeps existing imports intact.
    prompt: |
      Review claim:
      - Implement contact-surface wiring updates in a typed and deterministic way.
      Review lane:
      - behavior
      Safety invariant:
      - Keep the change focused on packages/foo/src/surface.ts.
      Slice rationale:
      - Regression proof belongs in a later workflow task.
      Architectural effect:
      - The contact surface exposes the new wiring path.
      Goal:
      - Implement contact-surface wiring updates in a typed and deterministic way.
      Motivation:
      - Keep task execution intent explicit for delegated AI execution.
      Alternative considerations:
      - Option A (chosen): direct contact-surface wiring.
      - Option B: defer via adapter layer.
      Implementation details:
      - Modify packages/foo/src/surface.ts and preserve existing contract imports.
      Non-goals:
      - Do not add regression tests or docs in this slice.
      Acceptance criteria:
      - Ensure the new surface compiles and keeps existing imports intact.
      Assume no prior context. Modify packages/foo/src/surface.ts only. Pass condition: exits 0 after the surface compiles cleanly.
    dependencies: []
  - id: add-regression-tests
    description: |
      Review claim:
      - Add regression coverage for the new surface wiring.
      Review lane:
      - proof
      Safety invariant:
      - This task is proof-only and depends on the behavior slice.
      Slice rationale:
      - Keep regression proof separate from behavior wiring.
      Architectural effect:
      - No production architecture change; proof documents the contact-surface path.
      Goal:
      - Add regression proof for the surface change.
      Motivation:
      - Ensure behavior is preserved after wiring changes.
      Alternative considerations:
      - Option A (chosen): focused deterministic proof.
      - Option B: full-suite verification.
      Implementation details:
      - Add focused deterministic regression coverage.
      Non-goals:
      - Do not modify production contact-surface code in this slice.
      Feature: app_regression
      Feature state: active
      Files:
      - packages/foo/src/__tests__/surface.test.ts
      Change types:
      - packages/foo/src/__tests__/surface.test.ts: modify
      Acceptance criteria:
      - Verify the regression reproduces the new behavior deterministically.
    prompt: |
      Review claim:
      - Add regression coverage for the new surface wiring.
      Review lane:
      - proof
      Safety invariant:
      - Keep the change inside packages/foo/src/__tests__/surface.test.ts.
      Slice rationale:
      - Proof is easier to review separately from behavior wiring.
      Architectural effect:
      - No production architecture change; this task only adds proof.
      Goal:
      - Add deterministic regression coverage for the new contact-surface path.
      Motivation:
      - Prevent silent behavior regressions after wiring changes.
      Alternative considerations:
      - Option A (chosen): focused deterministic proof.
      - Option B: full-suite tests.
      Implementation details:
      - Modify packages/foo/src/__tests__/surface.test.ts to cover the new path.
      Non-goals:
      - Do not modify production surface wiring in this slice.
      Acceptance criteria:
      - Verify the regression reproduces the new behavior deterministically.
      Assume no prior context. Modify packages/foo/src/__tests__/surface.test.ts only. Pass condition: exits 0 after the focused regression passes.
    dependencies: [implement-surface]
  - id: verify-surface
    description: |
      Review claim:
      - Run focused verification for the changed surface.
      Review lane:
      - proof
      Safety invariant:
      - This command changes no production code and only validates earlier slices.
      Slice rationale:
      - Keep terminal proof focused on the changed surface.
      Architectural effect:
      - No architecture change.
      Goal:
      - Run focused verification for the changed surface.
      Motivation:
      - Prove the behavior without a package-wide or full-suite gate.
      Alternative considerations:
      - Option A (chosen): focused file-level verification.
      - Option B: full repository regression.
      Implementation details:
      - Execute a deterministic proof command after earlier tasks complete.
      Non-goals:
      - Do not modify source files.
      Feature: e2e_regression
      Feature state: active
    command: "test -f packages/foo/src/surface.ts"
    dependencies: [implement-surface, add-regression-tests]
EOF

  bash "$LINT_SCRIPT" "$temp_plan" >/dev/null
}

test_lint_rejects_multi_prompt_standalone_without_waiver() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: "Invalid multi-prompt standalone workflow"
description: "Implementation workflow with multiple prompt slices but no stack context."
onFinish: pull_request
mergeMode: external_review
repoUrl: git@github.com:example-org/acme-repo.git
tasks:
  - id: implement-surface
    description: |
      Goal:
      - Implement the contact surface slice.
      Motivation:
      - Keep the first implementation step reviewable.
      Alternative considerations:
      - Option A (chosen): implement directly.
      - Option B: defer implementation.
      Implementation details:
      - Update packages/foo/src/surface.ts.
      Feature: contact_surface
      Feature state: active
    prompt: |
      Goal:
      - Implement the contact surface slice.
      Motivation:
      - Keep execution deterministic.
      Alternative considerations:
      - Option A (chosen): update packages/foo/src/surface.ts.
      - Option B: do nothing.
      Implementation details:
      - Modify packages/foo/src/surface.ts for the new behavior.
      Acceptance criteria:
      - Verify the first implementation slice is present.
    dependencies: []
  - id: implement-bridge
    description: |
      Goal:
      - Implement the bridge slice.
      Motivation:
      - Keep the second implementation step reviewable.
      Alternative considerations:
      - Option A (chosen): implement directly.
      - Option B: defer implementation.
      Implementation details:
      - Update packages/foo/src/bridge.ts.
      Feature: app_bridge
      Feature state: active
    prompt: |
      Goal:
      - Implement the bridge slice.
      Motivation:
      - Keep execution deterministic.
      Alternative considerations:
      - Option A (chosen): update packages/foo/src/bridge.ts.
      - Option B: do nothing.
      Implementation details:
      - Modify packages/foo/src/bridge.ts for the new behavior.
      Acceptance criteria:
      - Verify the second implementation slice is present.
    dependencies: [implement-surface]
  - id: final-regression
    description: |
      Goal:
      - Run final full-suite regression gate.
      Motivation:
      - Validate all standalone tasks together.
      Alternative considerations:
      - Option A (chosen): root full-suite verification.
      - Option B: package-only checks.
      Implementation details:
      - Execute the repository test gate.
      Feature: e2e_regression
      Feature state: active
    command: "pnpm run test:all"
    dependencies: [implement-surface, implement-bridge]
EOF

  local output
  set +e
  output=$(bash "$LINT_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected lint to reject multi-prompt standalone workflow without waiver" >&2
    return 1
  fi

  if ! grep -q 'Standalone implementation workflow has multiple prompt tasks but no stack context' <<<"$output"; then
    echo "Expected standalone stack-context lint error, got: $output" >&2
    return 1
  fi
}


test_lint_allows_nonterminal_stack_workflow_without_test_all() {
  local temp_dir first_plan second_plan stack_manifest
  temp_dir=$(mktemp -d)
  trap "rm -rf $temp_dir" RETURN
  first_plan="$temp_dir/stack-step-1.yaml"
  second_plan="$temp_dir/stack-step-2.yaml"
  stack_manifest="$temp_dir/stack-manifest.json"

  cat > "$first_plan" <<'EOF'
name: "Stack step 1 with focused verification"
description: "First implementation workflow in a stack with focused verification."
onFinish: pull_request
mergeMode: external_review
repoUrl: git@github.com:example-org/acme-repo.git
featureBranch: plan/stack-step-1
tasks:
  - id: implement-surface
    description: |
      Review claim:
      - Implement the first stacked workflow surface change.
      Review lane:
      - behavior
      Safety invariant:
      - The change stays inside one contact-surface file.
      Slice rationale:
      - Keep non-terminal stack workflows fast while preserving focused verification.
      Architectural effect:
      - The first stack slice updates the contact-surface behavior only.
      Goal:
      - Implement the first stacked workflow surface change.
      Motivation:
      - Keep non-terminal stack workflows fast while preserving focused verification.
      Alternative considerations:
      - Option A (chosen): focused verification before the PR gate.
      - Option B: broad suite verification in every stack layer.
      Implementation details:
      - Update packages/foo/src/surface.ts with the stack step one behavior.
      Non-goals:
      - Do not add proof-only changes in this slice.
      Feature: contact_surface
      Feature state: active
      Files:
      - packages/foo/src/surface.ts
      Change types:
      - packages/foo/src/surface.ts: modify
      Acceptance criteria:
      - The focused package verification task passes.
    prompt: |
      Review claim:
      - Implement the first stacked workflow surface change.
      Review lane:
      - behavior
      Safety invariant:
      - Keep the change scoped to packages/foo/src/surface.ts.
      Slice rationale:
      - Focused verification remains separate.
      Architectural effect:
      - The first stack slice updates the contact-surface behavior only.
      Goal:
      - Implement the first stacked workflow surface change in packages/foo/src/surface.ts.
      Motivation:
      - Keep non-terminal stack workflows fast while preserving focused verification.
      Alternative considerations:
      - Option A (chosen): focused verification before the PR gate.
      - Option B: broad suite verification in every stack layer.
      Implementation details:
      - Assume no prior context. Update packages/foo/src/surface.ts with the stack step one behavior.
      Non-goals:
      - Do not add proof-only changes in this slice.
      Acceptance criteria:
      - Pass condition: focused verification exits 0 after this change.
    dependencies: []
  - id: verify-surface
    description: |
      Review claim:
      - Run focused verification for the first stacked workflow.
      Review lane:
      - proof
      Safety invariant:
      - This command changes no production code.
      Slice rationale:
      - Catch local regressions with focused proof.
      Architectural effect:
      - No architecture change.
      Goal:
      - Run focused verification for the first stacked workflow.
      Motivation:
      - Catch local regressions with focused proof.
      Alternative considerations:
      - Option A (chosen): file-level verification command.
      - Option B: broad suite verification in every stack layer.
      Implementation details:
      - Execute a deterministic proof command for packages/foo.
      Non-goals:
      - Do not modify source files.
      Feature: app_regression
      Feature state: active
    command: "test -f packages/foo/src/surface.ts"
    dependencies: [implement-surface]
EOF

  cat > "$second_plan" <<'EOF'
name: "Stack step 2 focused verification"
description: "Terminal implementation workflow in a stack with focused verification."
onFinish: pull_request
mergeMode: external_review
repoUrl: git@github.com:example-org/acme-repo.git
baseBranch: plan/stack-step-1
featureBranch: plan/stack-step-2
externalDependencies:
  - workflowId: wf-upstream
    taskId: "__merge__"
    requiredStatus: completed
    gatePolicy: completed
tasks:
  - id: implement-terminal-surface
    description: |
      Review claim:
      - Implement the terminal stacked workflow surface change.
      Review lane:
      - behavior
      Safety invariant:
      - The terminal change stays inside one contact-surface file.
      Slice rationale:
      - Validate the integrated stack at the final workflow only.
      Architectural effect:
      - The terminal slice updates the final contact-surface behavior.
      Goal:
      - Implement the terminal stacked workflow surface change.
      Motivation:
      - Validate the integrated stack at the final workflow only.
      Alternative considerations:
      - Option A (chosen): focused proof at stack end.
      - Option B: broad suite verification in every stack layer.
      Implementation details:
      - Update packages/foo/src/terminal-surface.ts with the stack terminal behavior.
      Non-goals:
      - Do not add proof-only changes in this slice.
      Feature: contact_surface
      Feature state: active
      Files:
      - packages/foo/src/terminal-surface.ts
      Change types:
      - packages/foo/src/terminal-surface.ts: modify
      Acceptance criteria:
      - The terminal focused verification passes.
    prompt: |
      Review claim:
      - Implement the terminal stacked workflow surface change.
      Review lane:
      - behavior
      Safety invariant:
      - Keep the change scoped to packages/foo/src/terminal-surface.ts.
      Slice rationale:
      - The final workflow still keeps proof separate.
      Architectural effect:
      - The terminal slice updates the final contact-surface behavior.
      Goal:
      - Implement the terminal stacked workflow surface change in packages/foo/src/terminal-surface.ts.
      Motivation:
      - Validate the integrated stack at the final workflow only.
      Alternative considerations:
      - Option A (chosen): focused proof at stack end.
      - Option B: broad suite verification in every stack layer.
      Implementation details:
      - Assume no prior context. Update packages/foo/src/terminal-surface.ts with the stack terminal behavior.
      Non-goals:
      - Do not add proof-only changes in this slice.
      Acceptance criteria:
      - Pass condition: the focused verification exits 0.
    dependencies: []
  - id: verify-terminal-surface
    description: |
      Review claim:
      - Run focused verification for the stack.
      Review lane:
      - proof
      Safety invariant:
      - This command changes no production code.
      Slice rationale:
      - Validate the terminal slice with focused proof.
      Architectural effect:
      - No architecture change.
      Goal:
      - Run focused verification for the stack.
      Motivation:
      - Validate the terminal slice with focused proof.
      Alternative considerations:
      - Option A (chosen): file-level verification command.
      - Option B: broad suite verification.
      Implementation details:
      - Execute a deterministic proof command after all earlier terminal-workflow tasks complete.
      Non-goals:
      - Do not modify source files.
      Feature: e2e_regression
      Feature state: active
    command: "test -f packages/foo/src/terminal-surface.ts"
    dependencies: [implement-terminal-surface]
EOF

  cat > "$stack_manifest" <<EOF
{
  "workflows": [
    { "label": "Stack step 1", "planFile": "$first_plan", "order": 1 },
    { "label": "Stack step 2", "planFile": "$second_plan", "order": 2 }
  ]
}
EOF

  bash "$LINT_SCRIPT" --stack-manifest "$stack_manifest" "$first_plan" >/dev/null
  bash "$LINT_SCRIPT" --stack-manifest "$stack_manifest" "$second_plan" >/dev/null
}


test_lint_requires_design_sections_for_prompt_tasks() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: "Invalid prompt task missing design sections"
description: "Implementation plan missing structured rationale headings"
onFinish: pull_request
mergeMode: external_review
repoUrl: git@github.com:example-org/acme-repo.git
tasks:
  - id: implement-bridge
    description: |
      Goal:
      - Add bridge path for cost query wiring.
      Motivation:
      - Ensure query surface remains deterministic and testable.
      Alternative considerations:
      - Option A (chosen): bridge in app layer.
      - Option B: distributed adapters.
      Implementation details:
      - Keep bridge in app layer and add deterministic tests.
      Feature: app_bridge
      Feature state: active
      Acceptance criteria:
      - Ensure bridge compiles.
    prompt: |
      Modify packages/app/src/main.ts and packages/app/src/headless.ts.
      Ensure the bridge path is wired and tests remain stable.
    dependencies: []
  - id: final-regression
    description: |
      Goal:
      - Run final full-suite regression gate.
      Motivation:
      - Ensure bridge changes remain stable.
      Alternative considerations:
      - Option A (chosen): full repository regression.
      - Option B: package-only checks.
      Implementation details:
      - Execute root-level test gate after implementation task.
      Run full regression gate.
      Feature: app_regression
      Feature state: active
    command: "pnpm run test:all"
    dependencies: [implement-bridge]
EOF

  local output
  set +e
  output=$(bash "$LINT_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected lint to reject prompt missing Goal/Motivation/Alternatives/Implementation sections" >&2
    return 1
  fi

  if ! grep -q 'prompt missing required "Goal:" section' <<<"$output"; then
    echo "Expected prompt Goal section lint error, got: $output" >&2
    return 1
  fi
}

test_lint_requires_review_compression_sections() {
  local fixture="$NEGATIVE_DIR/anti-pattern-k-missing-review-compression.yaml"
  local output
  set +e
  output=$(bash "$LINT_SCRIPT" --strict-delegation "$fixture" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected lint to reject missing review-compression sections" >&2
    return 1
  fi

  if ! grep -q 'missing required "Review claim:" section' <<<"$output"; then
    echo "Expected Review claim lint error, got: $output" >&2
    return 1
  fi
  if ! grep -q 'missing required "Safety invariant:" section' <<<"$output"; then
    echo "Expected Safety invariant lint error, got: $output" >&2
    return 1
  fi
}

test_lint_accepts_design_sections_for_prompt_tasks() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: "Valid prompt task with design sections"
description: "Implementation plan with required design headings"
onFinish: pull_request
mergeMode: external_review
repoUrl: git@github.com:example-org/acme-repo.git
tasks:
  - id: implement-bridge
    description: |
      Review claim:
      - Add bridge path for cost query wiring.
      Review lane:
      - behavior
      Safety invariant:
      - The change stays inside the app bridge and directly affected tests.
      Slice rationale:
      - Bridge behavior lands before regression proof.
      Architectural effect:
      - Cost query requests gain deterministic app-bridge routing.
      Goal:
      - Add bridge path for cost query wiring.
      Motivation:
      - Ensure query surface remains deterministic and testable.
      Alternative considerations:
      - Option A (chosen): bridge in app layer.
      - Option B: distributed adapters.
      Implementation details:
      - Keep bridge in app layer and add deterministic tests.
      Non-goals:
      - Do not add regression-only proof or docs in this slice.
      Feature: app_bridge
      Feature state: active
      Files:
      - packages/app/src/main.ts
      - packages/app/src/headless.ts
      Change types:
      - packages/app/src/main.ts: modify
      - packages/app/src/headless.ts: modify
      Acceptance criteria:
      - Ensure bridge compiles and tests pass.
    prompt: |
      Review claim:
      - Add bridge path for cost query wiring.
      Review lane:
      - behavior
      Safety invariant:
      - Keep the change focused on the app bridge files.
      Slice rationale:
      - Regression proof belongs in later proof tasks.
      Architectural effect:
      - Cost query requests gain deterministic app-bridge routing.
      Goal:
      - Implement deterministic app-bridge wiring for the cost query path.
      Motivation:
      - Keep execution instructions explicit for delegated AI execution.
      Alternative considerations:
      - Option A (chosen): bridge in app layer.
      - Option B: distributed adapters.
      Implementation details:
      - Update packages/app/src/main.ts and packages/app/src/headless.ts.
      - Preserve current call contracts and deterministic output expectations.
      Non-goals:
      - Do not add regression-only proof or docs in this slice.
      Acceptance criteria:
      - Verify app tests pass and output remains stable.
      Assume no prior context. Modify packages/app/src/main.ts and packages/app/src/headless.ts only. Pass condition: exits 0 after the bridge tests pass.
    dependencies: []
  - id: final-regression
    description: |
      Review claim:
      - Run final full-suite regression gate.
      Review lane:
      - proof
      Safety invariant:
      - This command changes no production code.
      Slice rationale:
      - Keep the terminal full-suite gate separate from implementation.
      Architectural effect:
      - No architecture change.
      Goal:
      - Run final full-suite regression gate.
      Motivation:
      - Ensure bridge changes remain stable.
      Alternative considerations:
      - Option A (chosen): full repository regression.
      - Option B: package-only checks.
      Implementation details:
      - Execute root-level test gate after implementation task.
      Non-goals:
      - Do not modify source files.
      Feature: app_regression
      Feature state: active
    command: "pnpm run test:all"
    dependencies: [implement-bridge]
EOF

  bash "$LINT_SCRIPT" "$temp_plan" >/dev/null
}

test_lint_requires_design_sections_for_command_tasks() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: "Invalid command task missing design sections"
description: "Implementation plan with command step missing rationale headings"
onFinish: pull_request
mergeMode: external_review
repoUrl: git@github.com:example-org/acme-repo.git
tasks:
  - id: run-focused-verification
    description: |
      Run focused verification.
      Feature: app_regression
      Feature state: active
      Acceptance criteria:
      - Ensure focused tests pass.
    command: "cd packages/app && pnpm test"
    dependencies: []
  - id: final-regression
    description: |
      Review claim:
      - Run final full-suite regression gate.
      Review lane:
      - proof
      Safety invariant:
      - This command changes no production behavior.
      Slice rationale:
      - Keep final regression separate from implementation steps.
      Architectural effect:
      - No architecture change.
      Goal:
      - Run final full-suite regression gate.
      Motivation:
      - Ensure bridge changes remain stable.
      Alternative considerations:
      - Option A (chosen): full repository regression.
      - Option B: package-only checks.
      Implementation details:
      - Execute root-level test gate after implementation task.
      Non-goals:
      - Do not modify source files.
      Feature: app_regression
      Feature state: active
    command: "pnpm run test:all"
    dependencies: [run-focused-verification]
EOF

  local output
  set +e
  output=$(bash "$LINT_SCRIPT" "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected lint to reject command task missing rationale sections" >&2
    return 1
  fi

  if ! grep -q 'Task "run-focused-verification" missing required "Goal:" section' <<<"$output"; then
    echo "Expected command-task Goal section lint error, got: $output" >&2
    return 1
  fi
}

test_lint_strict_accepts_zero_context_prompt_contract() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: "Strict prompt contract pass"
description: "Implementation plan with zero-context prompt contract"
onFinish: pull_request
mergeMode: external_review
repoUrl: git@github.com:example-org/acme-repo.git
tasks:
  - id: implement-runtime-flow
    description: |
      Review claim:
      - Implement deterministic runtime flow updates in task-runner.
      Review lane:
      - behavior
      Safety invariant:
      - The change is scoped to one execution-engine file and verified by package tests.
      Slice rationale:
      - Runtime implementation is separate from terminal full-suite validation.
      Architectural effect:
      - Updates the execution-engine runtime path without changing external surfaces.
      Goal:
      - Implement deterministic runtime flow updates.
      Motivation:
      - Keep remote execution instructions explicit and reproducible.
      Alternative considerations:
      - Option A (chosen): apply targeted runtime updates.
      - Option B: delay updates until a later refactor.
      Implementation details:
      - Apply runtime-flow edits and preserve current behavior contracts.
      Non-goals:
      - Do not add proof harness or docs in this slice.
      Feature: transport
      Feature state: active
      Files:
      - packages/execution-engine/src/task-runner.ts
      Change types:
      - packages/execution-engine/src/task-runner.ts: modify
      Acceptance criteria:
      - `cd packages/execution-engine && pnpm test` exits 0.
    prompt: |
      Review claim:
      - Implement deterministic runtime flow updates in task-runner.
      Review lane:
      - behavior
      Safety invariant:
      - Keep the change scoped to packages/execution-engine/src/task-runner.ts.
      Slice rationale:
      - Terminal regression remains separate.
      Architectural effect:
      - The runtime path stays deterministic for delegated execution.
      Goal:
      - Implement deterministic runtime flow updates in task-runner.
      Motivation:
      - Ensure execution can succeed when delegated to a remote runner.
      Alternative considerations:
      - Option A (chosen): targeted updates in task-runner.
      - Option B: broad refactor across unrelated modules.
      Implementation details:
      - Assume no prior context; read packages/execution-engine/src/task-runner.ts and apply the scoped runtime changes.
      - Keep behavior deterministic and document expected output in task notes.
      Non-goals:
      - Do not add proof harness or docs in this slice.
      Acceptance criteria:
      - Verify `cd packages/execution-engine && pnpm test` exits 0.
      - Use exit code 0 as the pass condition.
    dependencies: []
  - id: final-regression
    description: |
      Review claim:
      - Run the terminal full-suite regression gate for runtime changes.
      Review lane:
      - proof
      Safety invariant:
      - This command changes no production code and depends on runtime implementation.
      Slice rationale:
      - Terminal validation is separate from implementation work.
      Architectural effect:
      - No architecture changes; validates integrated behavior.
      Goal:
      - Run final full-suite regression gate.
      Motivation:
      - Ensure implementation updates remain stable.
      Alternative considerations:
      - Option A (chosen): full repository regression.
      - Option B: package-only checks.
      Implementation details:
      - Execute root-level test gate after implementation task.
      Non-goals:
      - Do not modify source files.
      Feature: app_regression
      Feature state: active
    command: "pnpm run test:all"
    dependencies: [implement-runtime-flow]
EOF

  bash "$LINT_SCRIPT" --strict-delegation "$temp_plan" >/dev/null
}

test_lint_strict_rejects_missing_zero_context_contract() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: "Strict prompt contract fail"
description: "Implementation plan missing strict zero-context requirements"
onFinish: pull_request
mergeMode: external_review
repoUrl: git@github.com:example-org/acme-repo.git
tasks:
  - id: implement-runtime-flow
    description: |
      Goal:
      - Implement deterministic runtime flow updates.
      Motivation:
      - Keep remote execution instructions explicit and reproducible.
      Alternative considerations:
      - Option A (chosen): apply targeted runtime updates.
      - Option B: delay updates until a later refactor.
      Implementation details:
      - Apply runtime-flow edits and preserve current behavior contracts.
      Feature: transport
      Feature state: active
    prompt: |
      Goal:
      - Implement deterministic runtime flow updates in task-runner.
      Motivation:
      - Ensure execution can succeed when delegated to a remote runner.
      Alternative considerations:
      - Option A (chosen): targeted updates in task-runner.
      - Option B: broad refactor across unrelated modules.
      Implementation details:
      - Read packages/execution-engine/src/task-runner.ts and apply scoped changes.
      Acceptance criteria:
      - Verify tests pass.
    dependencies: []
  - id: final-regression
    description: |
      Goal:
      - Run final full-suite regression gate.
      Motivation:
      - Ensure implementation updates remain stable.
      Alternative considerations:
      - Option A (chosen): full repository regression.
      - Option B: package-only checks.
      Implementation details:
      - Execute root-level test gate after implementation task.
      Feature: app_regression
      Feature state: active
    command: "pnpm run test:all"
    dependencies: [implement-runtime-flow]
EOF

  local output
  set +e
  output=$(bash "$LINT_SCRIPT" --strict-delegation "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected strict lint to reject missing zero-context prompt contract" >&2
    return 1
  fi

  if ! grep -q 'requires a "Files:" section in description for zero-context remote runners' <<<"$output"; then
    echo "Expected strict Files heading error, got: $output" >&2
    return 1
  fi
}

test_lint_requires_review_lane() {
  local temp_plan
  temp_plan=$(mktemp)
  trap "rm -f $temp_plan" RETURN

  cat > "$temp_plan" <<'EOF'
name: "Missing review lane"
description: "Implementation plan missing review lane metadata."
onFinish: pull_request
mergeMode: external_review
repoUrl: git@github.com:example-org/acme-repo.git
tasks:
  - id: implement-owner-fallback
    description: |
      Review claim:
      - Add local fallback when refresh loses the owner bridge.
      Safety invariant:
      - The fallback behavior stays local to refresh handling.
      Slice rationale:
      - Keep the behavior change isolated from repro proof.
      Architectural effect:
      - Refresh can read local state when the owner bridge is gone.
      Goal:
      - Implement the local fallback.
      Motivation:
      - Prevent stale task graph state.
      Alternative considerations:
      - Option A (chosen): keep proof separate.
      Implementation details:
      - Modify the refresh path only.
      Non-goals:
      - Do not add repro scripts here.
      Feature: app_bridge
      Feature state: active
      Files:
      - packages/app/src/main.ts
      Change types:
      - packages/app/src/main.ts: modify
      Acceptance criteria:
      - Pass condition: exits 0 after the fallback compiles.
    prompt: |
      Review claim:
      - Add local fallback when refresh loses the owner bridge.
      Safety invariant:
      - Keep the change local.
      Slice rationale:
      - Repro proof stays separate.
      Architectural effect:
      - Refresh can fall back locally.
      Goal:
      - Implement the fallback.
      Motivation:
      - Keep the UI current after owner loss.
      Alternative considerations:
      - Option A (chosen): behavior only.
      Implementation details:
      - Modify packages/app/src/main.ts only.
      Non-goals:
      - Do not add repro or docs changes.
      Assume no prior context. Modify packages/app/src/main.ts only. Pass condition: exits 0 after the fallback compiles.
    dependencies: []
  - id: final-regression
    description: |
      Review claim:
      - Run the final regression gate.
      Review lane:
      - proof
      Safety invariant:
      - This command changes no production behavior.
      Slice rationale:
      - Regression stays separate.
      Architectural effect:
      - No architecture change.
      Goal:
      - Run the full-suite regression gate.
      Motivation:
      - Validate the workflow.
      Alternative considerations:
      - Option A (chosen): run pnpm run test:all.
      Implementation details:
      - Execute the root regression command.
      Non-goals:
      - Do not modify code.
      Feature: app_regression
      Feature state: active
    command: "pnpm run test:all"
    dependencies: [implement-owner-fallback]
EOF

  local output
  set +e
  output=$(bash "$LINT_SCRIPT" --strict-delegation "$temp_plan" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected lint to reject missing review lane" >&2
    return 1
  fi

  if ! grep -q 'missing required "Review lane:" heading' <<<"$output"; then
    echo "Expected review lane lint error, got: $output" >&2
    return 1
  fi
}

test_lint_rejects_behavior_plus_proof_files() {
  local fixture="$NEGATIVE_DIR/anti-pattern-l-behavior-plus-proof.yaml"
  local output
  set +e
  output=$(bash "$LINT_SCRIPT" --strict-delegation "$fixture" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected lint to reject behavior lane mixed with proof files" >&2
    return 1
  fi

  if ! grep -q 'mixes Review lane "behavior" with policy/docs/proof files' <<<"$output"; then
    echo "Expected behavior-plus-proof lint error, got: $output" >&2
    return 1
  fi
}

test_lint_rejects_refactor_plus_fields() {
  local fixture="$NEGATIVE_DIR/anti-pattern-m-refactor-plus-fields.yaml"
  local output
  set +e
  output=$(bash "$LINT_SCRIPT" --strict-delegation "$fixture" 2>&1)
  local exit_code=$?
  set -e

  if [[ $exit_code -eq 0 ]]; then
    echo "Expected lint to reject refactor lane mixed with field additions" >&2
    return 1
  fi

  if ! grep -q 'mixes Review lane refactor with new field/schema/behavior language' <<<"$output"; then
    echo "Expected refactor-plus-fields lint error, got: $output" >&2
    return 1
  fi
}

# Check dependencies
if ! command -v jq &>/dev/null; then
  fail "jq is required for JSON parsing tests"
fi

if [[ ! -f "$VALIDATE_SCRIPT" ]]; then
  fail "Validator script not found: $VALIDATE_SCRIPT"
fi

if [[ ! -f "$LINT_SCRIPT" ]]; then
  fail "Lint script not found: $LINT_SCRIPT"
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
    fixture_name="$(basename "$fixture")"
    if is_doctor_negative_fixture "$fixture_name"; then
      run_test "Negative (skill-doctor): $fixture_name" test_doctor_negative_fixture "$fixture"
    else
      run_test "Negative: $fixture_name" test_negative_fixture "$fixture"
    fi
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
run_test "Edge: unsupported runnerKind field" test_runner_kind_is_unsupported
run_test "Lint: allow focused verification without test:all" test_lint_allows_focused_verification_without_test_all
run_test "Lint: reject multi-prompt standalone without waiver" test_lint_rejects_multi_prompt_standalone_without_waiver
run_test "Lint: allow stack workflows with focused verification" test_lint_allows_nonterminal_stack_workflow_without_test_all
run_test "Lint: reject missing design sections for prompt tasks" test_lint_requires_design_sections_for_prompt_tasks
run_test "Lint: reject missing review-compression sections" test_lint_requires_review_compression_sections
run_test "Lint: reject missing review lane" test_lint_requires_review_lane
run_test "Lint: reject behavior lane mixed with proof files" test_lint_rejects_behavior_plus_proof_files
run_test "Lint: reject refactor lane mixed with field additions" test_lint_rejects_refactor_plus_fields
run_test "Lint: accept prompt tasks with design sections" test_lint_accepts_design_sections_for_prompt_tasks
run_test "Lint: reject missing design sections for command tasks" test_lint_requires_design_sections_for_command_tasks
run_test "Lint strict: accept zero-context prompt contract" test_lint_strict_accepts_zero_context_prompt_contract
run_test "Lint strict: reject missing zero-context prompt contract" test_lint_strict_rejects_missing_zero_context_contract

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
