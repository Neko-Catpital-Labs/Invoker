# INV-63 Experiment Brief: Deterministic plan-to-invoker proof

## Goal

Establish deterministic experiment proof for INV-63 so plan-to-invoker architecture choices are evidence-backed and reviewable.

## Files under test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`
- `scripts/test-plan-to-invoker-skill.sh`
- `skills/plan-to-invoker/scripts/test-validate-plan.sh`
- `skills/plan-to-invoker/scripts/test-fixtures.sh`
- `skills/plan-to-invoker/scripts/test-policy-coverage.sh`
- `skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml`
- `skills/plan-to-invoker/fixtures/negative/anti-pattern-j-zero-context-missing-metadata.yaml`
- `plans/plan-to-invoker-deterministic-step-1-validator.yaml`

## Selected approach

Use `skills/plan-to-invoker/scripts/skill-doctor.sh` as the primary deterministic command surface, with `scripts/test-plan-to-invoker-skill.sh` as the regression suite that verifies the skill contract, validator behavior, fixture behavior, policy coverage, and stack-manifest checks.

This approach is selected because `skill-doctor.sh` composes the relevant checks into one JSON result:

- assumption extraction
- verify-plan generation
- policy coverage degradation checks
- optional coverage-map and stack-manifest checks
- YAML schema validation
- strict atomicity linting
- parse-results validation

The architecture keeps individual scripts available for debugging while giving reviewers one deterministic entrypoint and one regression command.

## Competing design

Alternative: rely on separate ad hoc commands such as `validate-plan.sh`, `lint-task-atomicity.sh`, `extract-assumptions.sh`, and grep checks in reviews.

Verdict: reject as the primary design. The direct experiment below shows `validate-plan.sh` can pass while strict atomicity still fails. That split is useful for debugging, but as the review gate it creates an incomplete proof surface and lets reviewers miss zero-context prompt failures, short descriptions, policy coverage degradation, or missing final-gate behavior.

## Deterministic commands and thresholds

Run all commands from the repository root.

### 1. Skill copy drift check

Command:

```bash
diff -u skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md
```

Expected output:

```text
<no output>
```

Threshold:

- Exit code must be `0`.
- Any diff is a failure because the Cursor copy would no longer match the canonical skill contract.

Observed on 2026-05-25:

- Exit code `0`.
- No output.

Verdict: pass.

### 2. Doctor command contract

Command:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh --help
```

Expected output must include:

```text
skill-doctor.sh: Deterministic orchestrator for plan validation scripts
Usage: bash skill-doctor.sh [OPTIONS] <plan-file>
--source-file FILE
--coverage-map FILE
--stack-manifest FILE
Exit codes:
  0 = all checks passed
  1 = one or more checks failed
```

Threshold:

- Exit code must be `0`.
- Help output must document the primary options and deterministic exit-code contract.

Observed on 2026-05-25:

- Exit code `0`.
- Output contained the expected usage, option list, and exit-code contract.

Verdict: pass.

### 3. Full regression proof

Command:

```bash
bash scripts/test-plan-to-invoker-skill.sh
```

Expected output must include:

```text
OK: plan-to-invoker skill contract checks passed
Validator tests: 10/10 passed
Fixture tests: 50/50 passed
OK: policy coverage extraction, projection, traceability, and stack-manifest checks passed
```

Threshold:

- Exit code must be `0`.
- Validator tests must report `10/10 passed`.
- Fixture tests must report `50/50 passed`.
- Policy coverage regression tests must report the final `OK` line.

Observed on 2026-05-25:

- Exit code `0`.
- Output contained all expected threshold lines.

Verdict: pass.

### 4. Schema-only competing design check

Command:

```bash
bash skills/plan-to-invoker/scripts/validate-plan.sh \
  skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml && \
bash skills/plan-to-invoker/scripts/lint-task-atomicity.sh \
  --strict-delegation \
  skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml
```

Expected output shape:

```text
{"valid":true,"file":".../skills/plan-to-invoker/fixtures/positive/01-minimal-verification.yaml"}
Atomicity lint FAILED:
  - Task "check-core-tests" description too short (<5 words); make it specific and outcome-oriented
  - Task "check-executor-tests" description too short (<5 words); make it specific and outcome-oriented
```

Threshold:

- The first command may pass schema validation.
- The combined command must exit non-zero when strict atomicity fails.
- This proves schema-only validation is not sufficient as the selected review gate.

Observed on 2026-05-25:

- `validate-plan.sh` returned `valid: true`.
- `lint-task-atomicity.sh --strict-delegation` returned exit code `1` with the expected short-description failures.

Verdict: competing design rejected.

### 5. Doctor negative-path proof

Command:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  skills/plan-to-invoker/fixtures/negative/anti-pattern-j-zero-context-missing-metadata.yaml
```

Expected JSON fields:

```json
{
  "allPassed": false,
  "firstFailedStep": "lint-task-atomicity"
}
```

Expected lint output must include:

```text
Task "implement-runtime-flow" prompt execution requires a "Files:" section in description for zero-context remote runners
Task "implement-runtime-flow" prompt execution requires a "Change types:" section in description for zero-context remote runners
Task "implement-runtime-flow" prompt execution requires an "Acceptance criteria:" section in description for zero-context remote runners
Task "implement-runtime-flow" prompt must state zero-context execution expectations
Task "implement-runtime-flow" prompt must include deterministic pass/fail expectations
```

Threshold:

- Exit code must be `1`.
- JSON must set `allPassed` to `false`.
- JSON must set `firstFailedStep` to `lint-task-atomicity`.
- Output must name the zero-context metadata failures.

Observed on 2026-05-25:

- Exit code `1`.
- JSON reported `"allPassed": false` and `"firstFailedStep": "lint-task-atomicity"`.
- Output contained the expected zero-context prompt failure messages.

Verdict: pass.

### 6. Existing authored plan proof

Command:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  plans/plan-to-invoker-deterministic-step-1-validator.yaml
```

Expected JSON fields for the current repository state:

```json
{
  "allPassed": false,
  "firstFailedStep": "lint-task-atomicity"
}
```

Expected lint output must include missing implementation-plan rationale and prompt-handoff sections for tasks such as:

- `implement-typed-plan-validator`
- `add-validator-tests`
- `run-plan-to-invoker-script-tests`
- `post-fix-regression`

Threshold:

- Exit code must be `1` in the current state.
- Failure must occur at `lint-task-atomicity`.
- Failure must be explicit and actionable.

Observed on 2026-05-25:

- Exit code `1`.
- JSON reported `"allPassed": false` and `"firstFailedStep": "lint-task-atomicity"`.
- Output listed missing `Review claim:`, `Safety invariant:`, `Slice rationale:`, `Architectural effect:`, `Files:`, `Change types:`, `Acceptance criteria:`, zero-context framing, and deterministic pass/fail expectations.

Verdict: pass. The doctor identifies legacy authored-plan gaps that schema validation alone would not catch.

## Final decision

INV-63 should treat `skill-doctor.sh` plus `scripts/test-plan-to-invoker-skill.sh` as the deterministic proof architecture. Individual validators remain valuable fallback diagnostics, but they are not sufficient as the primary gate because they do not prove the complete policy surface.

Acceptance threshold for future INV-63 review:

- Skill copies must not drift.
- `skill-doctor.sh --help` must expose the deterministic command contract.
- `scripts/test-plan-to-invoker-skill.sh` must pass with the documented validator, fixture, and policy-coverage totals.
- Negative doctor fixtures must fail with structured JSON and actionable `firstFailedStep` values.
- Any implementation plan with `onFinish != none` must pass `skill-doctor.sh` before submission, unless the review explicitly documents a waiver and follow-up.
