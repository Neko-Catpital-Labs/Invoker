# Plan-to-Invoker Fixtures

This directory contains test fixtures for the plan-to-invoker skill validator. Fixtures are organized into positive (valid) and negative (invalid) examples.

## Purpose

These fixtures serve as:
1. **Automated test inputs** for the plan validator (`validate-plan.sh`)
2. **Reference examples** demonstrating valid plan patterns and common anti-patterns
3. **Regression prevention** ensuring the validator catches known error cases

## Directory Structure

```
fixtures/
├── positive/           # Valid plans that should pass validation
│   ├── 01-minimal-verification.yaml
│   ├── 02-feature-implementation.yaml
│   ├── 03-multi-step-refactor-worktrees.yaml
│   └── 04-large-refactor-pull-request.yaml
│
├── negative/           # Invalid plans that should fail validation
│   ├── anti-pattern-*.yaml     # Examples from the anti-patterns section
│   └── edge-*.yaml             # Edge cases for specific validation errors
│
└── README.md          # This file
```

## Positive Fixtures

Positive fixtures demonstrate valid plan patterns:

- **01-minimal-verification.yaml** - Verification-only plan with `onFinish: none`
- **02-feature-implementation.yaml** - Standard implement → test → verify pattern
- **03-multi-step-refactor-worktrees.yaml** - Multi-step refactor using worktrees
- **04-large-refactor-pull-request.yaml** - Complex plan with diamond dependencies and `onFinish: pull_request`

All positive fixtures are extracted from `references/examples.md` sections 1-4.

## Negative Fixtures

Negative fixtures demonstrate anti-patterns and validation errors:

### Anti-Patterns (from examples.md Section 5)

- **anti-pattern-a-npx-vitest.yaml** - Using `npx vitest run` instead of `pnpm test` (banned_pattern)
- **anti-pattern-b-tests-from-root.yaml** - Running tests from repo root instead of cd-ing into package
- **anti-pattern-c-both-command-and-prompt.yaml** - Task with both command and prompt (command_prompt_exclusive)
- **anti-pattern-d-missing-dependencies.yaml** - Task missing dependencies field (missing_required_field)
- **anti-pattern-e-no-verification.yaml** - Implementation without verification (policy violation)
- **anti-pattern-f-dangerous-commands.yaml** - Dangerous commands (rm -rf, force push, etc.)

### Edge Cases (specific validation errors)

- **edge-missing-name.yaml** - Missing required `name` field
- **edge-missing-repo-url.yaml** - Missing required `repoUrl` field
- **edge-empty-tasks.yaml** - Empty tasks array (empty_required_field)
- **edge-missing-task-id.yaml** - Task missing `id` field
- **edge-missing-task-description.yaml** - Task missing `description` field
- **edge-neither-command-nor-prompt.yaml** - Task with neither command nor prompt
- **edge-invalid-merge-mode.yaml** - Invalid `mergeMode` enum value
- **edge-invalid-on-finish.yaml** - Invalid `onFinish` enum value
- **edge-invalid-executor-type.yaml** - Invalid `executorType` enum value
- **edge-invalid-dependency-reference.yaml** - Dependency on non-existent task
- **edge-missing-description-for-pr.yaml** - Missing description when `onFinish: pull_request`
- **edge-cyclic-dependency.yaml** - Cyclic dependency (may require cycle detection)
- **edge-invalid-external-dependency.yaml** - Invalid externalDependency enum values

## Error Types

Negative fixtures expect these error types from the validator:

- `missing_required_field` - Required field is missing
- `empty_required_field` - Required array/list is empty
- `invalid_enum_value` - Enum field has invalid value
- `command_prompt_exclusive` - Task has both command and prompt
- `missing_command_or_prompt` - Task has neither command nor prompt
- `banned_pattern` - Command contains banned pattern (e.g., `npx vitest run`)
- `invalid_dependency_reference` - Dependency references non-existent task

## Usage in Tests

The test script `skills/plan-to-invoker/scripts/test-validate-plan.sh` uses these fixtures:

```bash
# Positive fixtures should pass
bash skills/plan-to-invoker/scripts/validate-plan.sh \
  skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml

# Negative fixtures should fail with deterministic errors
bash skills/plan-to-invoker/scripts/validate-plan.sh \
  skills/plan-to-invoker/fixtures/negative/edge-missing-name.yaml
```

Tests assert:
1. **Positive fixtures** return exit code 0 and `"valid": true` JSON
2. **Negative fixtures** return non-zero exit code and JSON array of errors with deterministic `errorType` and `field` keys

## Adding New Fixtures

When adding new fixtures:

1. **Positive fixtures**: Add to `positive/` with descriptive name and comments explaining the pattern
2. **Negative fixtures**: Add to `negative/` with prefix:
   - `anti-pattern-*` for anti-patterns from documentation
   - `edge-*` for specific validation edge cases
3. Include header comments documenting:
   - Source (which section of examples.md or which policy)
   - Expected errors (for negative fixtures)
   - Why this pattern is correct/incorrect
4. Update this README if adding new error types or categories
5. Add corresponding test case to `test-validate-plan.sh` if needed

## Relationship to examples.md

The `references/examples.md` file is the source of truth for plan patterns. Fixtures in this directory are **extracted from** examples.md and kept in sync. If examples.md changes:

1. Update corresponding fixture files
2. Ensure tests still pass
3. Add new fixtures for new examples

Fixtures are the **automated, testable form** of the examples. Examples.md provides the **narrative documentation** with explanations and context.
