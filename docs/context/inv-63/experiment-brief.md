# INV-63 Experiment Brief: deterministic plan-to-invoker proof

## Goal

Establish deterministic experiment proof for INV-63 so plan-to-invoker architecture choices are evidence-backed and reviewable.

## Files under test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`
- `skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml`
- `skills/plan-to-invoker/fixtures/negative/edge-missing-name.yaml`
- `skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.md`
- `skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.coverage-map.json`
- `skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.stack-manifest.json`
- `skills/plan-to-invoker/fixtures/policy/stack/task-invalidation-step-7-selected-experiment.template.yaml`

## Selected architecture

Use `skills/plan-to-invoker/scripts/skill-doctor.sh` as the deterministic primary validation surface, with `skills/plan-to-invoker/SKILL.md` and `.cursor/skills/plan-to-invoker/SKILL.md` kept byte-for-byte aligned as mirrored policy entrypoints.

This is the selected approach because one command returns a machine-readable JSON summary containing `allPassed`, `firstFailedStep`, and ordered per-check results. The script also preserves deterministic exit-code semantics: `0` for all checks passed, `1` for validation failures, and `2` for usage or argument errors.

## Alternative considered

Run the individual scripts manually as the primary proof surface:

- `extract-assumptions.sh`
- `generate-verify-plan.sh`
- `validate-plan.sh`
- `lint-task-atomicity.sh`
- `parse-results.sh`
- policy coverage helpers when applicable

Verdict: rejected as the primary design. It is useful for debugging, but it spreads proof across multiple commands and makes reviewers reconstruct ordering, first failure, skip behavior, and policy-matrix requirements by hand. The individual scripts remain fallback diagnostics after `skill-doctor.sh` identifies the failing step.

## Deterministic commands and expected outputs

### 1. Mirrored skill policy files

Command:

```bash
cmp -s skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md; echo "skill_md_cmp_exit=$?"
```

Expected reduced output:

```text
skill_md_cmp_exit=0
```

Threshold: exit must be exactly `0`. Any non-zero value means the canonical skill policy and Cursor mirror have diverged.

Verdict: pass. The two skill entrypoints are byte-for-byte identical.

### 2. Doctor script syntax

Command:

```bash
bash -n skills/plan-to-invoker/scripts/skill-doctor.sh; echo "bash_n_exit=$?"
```

Expected reduced output:

```text
bash_n_exit=0
```

Threshold: exit must be exactly `0`. Syntax errors block the selected architecture because the doctor cannot be a deterministic command surface.

Verdict: pass.

### 3. Doctor usage contract

Command:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh; echo "missing_arg_exit=$?"
```

Expected reduced output:

```text
ERROR: Plan file argument required
Usage: bash skill-doctor.sh [OPTIONS] <plan-file>
Run with --help for more information
missing_arg_exit=2
```

Threshold: missing plan file must return exit `2` and print usage guidance. This proves usage errors are separated from validation failures.

Verdict: pass.

### 4. Doctor non-atomicity validation lane

Command:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  --skip-atomicity \
  skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml \
  | jq '{allPassed, firstFailedStep, checkCount:(.checks|length), steps:[.checks[].stepId]}'
```

Expected reduced output:

```json
{
  "allPassed": true,
  "firstFailedStep": null,
  "checkCount": 5,
  "steps": [
    "extract-assumptions",
    "generate-verify-plan",
    "check-policy-coverage",
    "validate-plan",
    "parse-results"
  ]
}
```

Thresholds:

- `allPassed` must be `true`.
- `firstFailedStep` must be `null`.
- `checkCount` must be `5`.
- Step IDs must match the expected ordered list.

Verdict: pass. This proves the selected command surface can deterministically orchestrate assumption extraction, verify-plan generation, policy coverage smoke validation, YAML validation, and parse-results validation.

### 5. Strict atomicity boundary on existing positive fixture

Command:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml \
  | jq '{allPassed, firstFailedStep, checkCount:(.checks|length), steps:[.checks[].stepId]}'
```

Expected reduced output:

```json
{
  "allPassed": false,
  "firstFailedStep": "lint-task-atomicity",
  "checkCount": 6,
  "steps": [
    "extract-assumptions",
    "generate-verify-plan",
    "check-policy-coverage",
    "validate-plan",
    "lint-task-atomicity",
    "parse-results"
  ]
}
```

Thresholds:

- Exit must be `1`.
- `allPassed` must be `false`.
- `firstFailedStep` must be exactly `lint-task-atomicity`.
- `checkCount` must be `6`.

Verdict: expected fail. The fixture is still valid for the non-atomicity lane, but the current strict doctor correctly enforces the newer atomicity contract.

### 6. Negative fixture failure classification

Command:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  skills/plan-to-invoker/fixtures/negative/edge-missing-name.yaml \
  >/tmp/inv63-negative.json
code=$?
echo "negative_exit=$code"
jq -r '{allPassed,firstFailedStep,checkCount:(.checks|length),failedSteps:[.checks[]|select(.status=="failed")|.stepId]}' /tmp/inv63-negative.json
```

Expected reduced output:

```text
negative_exit=1
```

```json
{
  "allPassed": false,
  "firstFailedStep": "validate-plan",
  "checkCount": 6,
  "failedSteps": [
    "validate-plan",
    "lint-task-atomicity"
  ]
}
```

Thresholds:

- Exit must be `1`, not `2`.
- `firstFailedStep` must be exactly `validate-plan`.
- `failedSteps` must include `validate-plan`.

Verdict: pass. This proves malformed plan content is classified as a validation failure rather than a usage error.

### 7. Policy-matrix orchestration lane

Command:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  --source-file skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.md \
  --coverage-map skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.coverage-map.json \
  --stack-manifest skills/plan-to-invoker/fixtures/policy/task-invalidation-chart.stack-manifest.json \
  skills/plan-to-invoker/fixtures/policy/stack/task-invalidation-step-7-selected-experiment.template.yaml \
  | jq '{allPassed, firstFailedStep, checkCount:(.checks|length), steps:[.checks[].stepId]}'
```

Expected reduced output:

```json
{
  "allPassed": false,
  "firstFailedStep": "lint-task-atomicity",
  "checkCount": 8,
  "steps": [
    "extract-assumptions",
    "generate-verify-plan",
    "check-policy-coverage",
    "check-coverage-map",
    "check-stack-manifest",
    "validate-plan",
    "lint-task-atomicity",
    "parse-results"
  ]
}
```

Thresholds:

- `checkCount` must be `8`.
- Step IDs must include `check-coverage-map` and `check-stack-manifest`.
- `firstFailedStep` must be `lint-task-atomicity` for the current fixture state; an earlier failure means policy coverage, stack-manifest projection, or schema validation regressed.

Verdict: expected fail at strict atomicity, pass for policy-matrix orchestration coverage. This confirms the selected doctor design encodes policy-matrix proof requirements in the central command instead of leaving them to reviewer memory.

## Review thresholds

The experiment is accepted when:

- The mirrored skill docs compare equal with `cmp` exit `0`.
- `skill-doctor.sh` passes `bash -n`.
- Missing plan-file usage returns exit `2`.
- The non-atomicity lane returns `allPassed: true`, `firstFailedStep: null`, and exactly five ordered checks.
- The strict existing positive fixture failure remains classified at `lint-task-atomicity`, proving strict gating is active.
- The negative missing-name fixture fails with exit `1` and `firstFailedStep: validate-plan`.
- The policy-matrix lane executes exactly eight checks and includes both coverage-map and stack-manifest validation before atomicity.

## Final verdict

Selected approach stands: `skill-doctor.sh` should remain the primary deterministic proof surface, and individual scripts should remain fallback diagnostics. The observed outputs support this architecture because they provide stable exit codes, ordered JSON check results, explicit first-failure classification, mirrored skill-policy verification, and policy-matrix coverage gates that reviewers can reproduce directly.
