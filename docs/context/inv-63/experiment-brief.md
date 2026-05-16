# INV-63 Experiment Brief

## Goal

Establish deterministic proof that the `plan-to-invoker` architecture should use a script-backed validation surface, with `skill-doctor.sh` as the selected review gate, rather than relying on documentation or schema validation alone.

## Files under test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`
- `skills/plan-to-invoker/fixtures/negative/anti-pattern-g-monolithic-prompt-edit-bridge.yaml`
- `scripts/test-plan-to-invoker-skill.sh`

## Selected approach

Use the mirrored skill docs as policy declarations and `skills/plan-to-invoker/scripts/skill-doctor.sh` as the deterministic executable contract. The doctor command is the selected architecture because it combines assumption extraction, verification-plan generation, policy coverage checks, YAML validation, atomicity linting, and parse-results validation into one JSON-producing command with defined exit codes.

This aligns with the policy in `skills/plan-to-invoker/SKILL.md` that every deterministic step should run a command and produce pass/fail output. It also makes the experiment artifact rule reviewable: this brief is written to `docs/context/inv-63/experiment-brief.md` and committed by the experiment task.

## Competing design

The competing design is schema-only validation through `skills/plan-to-invoker/scripts/validate-plan.sh`, with docs as reviewer guidance. It is simpler, but it does not enforce the stricter implementation-plan requirements from the skill policy. The negative fixture `anti-pattern-g-monolithic-prompt-edit-bridge.yaml` proves this gap: schema validation accepts it, while `skill-doctor.sh` rejects it at `lint-task-atomicity`.

## Commands and expected outputs

Run all commands from the repository root.

### 1. Confirm mirrored skill docs

```bash
cmp -s skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md; printf 'skill_docs_identical=%s\n' $?
```

Expected output:

```text
skill_docs_identical=0
```

Verdict threshold: pass only when the exit code printed by `cmp` is `0`. Any other value means the Cursor-facing policy can drift from the primary skill policy.

Observed verdict: pass.

### 2. Confirm doctor script syntax

```bash
bash -n skills/plan-to-invoker/scripts/skill-doctor.sh; printf 'bash_n_exit=%s\n' $?
```

Expected output:

```text
bash_n_exit=0
```

Verdict threshold: pass only when `bash_n_exit=0`.

Observed verdict: pass.

### 3. Confirm public command surface

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh --help
```

Expected output must include:

```text
Usage: bash skill-doctor.sh [OPTIONS] <plan-file>
--skip-assumptions
--skip-atomicity
--skip-validation
--source-file FILE
--coverage-map FILE
--stack-manifest FILE
0 = all checks passed
1 = one or more checks failed
2 = usage/argument error
```

Verdict threshold: pass only when the help text exposes the same options and exit-code contract documented in both skill files.

Observed verdict: pass.

### 4. Confirm full skill regression suite

```bash
bash scripts/test-plan-to-invoker-skill.sh
```

Expected output must include:

```text
OK: plan-to-invoker skill contract checks passed
Validator tests: 10/10 passed
Fixture tests: 48/48 passed
OK: policy coverage extraction, projection, traceability, and stack-manifest checks passed
```

Verdict threshold: pass only when the command exits `0` and every listed summary line appears.

Observed verdict: pass.

### 5. Demonstrate selected approach catches a policy violation

```bash
set +e
bash skills/plan-to-invoker/scripts/skill-doctor.sh \
  skills/plan-to-invoker/fixtures/negative/anti-pattern-g-monolithic-prompt-edit-bridge.yaml \
  > /tmp/inv63-negative.json 2>/tmp/inv63-negative.err
code=$?
printf 'exit=%s\n' "$code"
jq '{allPassed, firstFailedStep, checks: [.checks[] | {stepId, status}]}' /tmp/inv63-negative.json
cat /tmp/inv63-negative.err
```

Expected output:

```text
exit=1
{
  "allPassed": false,
  "firstFailedStep": "lint-task-atomicity",
  "checks": [
    {"stepId": "extract-assumptions", "status": "passed"},
    {"stepId": "generate-verify-plan", "status": "passed"},
    {"stepId": "check-policy-coverage", "status": "passed"},
    {"stepId": "validate-plan", "status": "passed"},
    {"stepId": "lint-task-atomicity", "status": "failed"},
    {"stepId": "parse-results", "status": "passed"}
  ]
}
ERROR: First failed step: lint-task-atomicity
```

Verdict threshold: pass only when exit is `1`, `allPassed` is `false`, and `firstFailedStep` is `lint-task-atomicity`.

Observed verdict: pass.

### 6. Demonstrate schema-only competing design is insufficient

```bash
set +e
bash skills/plan-to-invoker/scripts/validate-plan.sh \
  skills/plan-to-invoker/fixtures/negative/anti-pattern-g-monolithic-prompt-edit-bridge.yaml \
  > /tmp/inv63-validate.out 2>/tmp/inv63-validate.err
code=$?
printf 'exit=%s\n' "$code"
cat /tmp/inv63-validate.out
cat /tmp/inv63-validate.err
```

Expected output:

```text
exit=0
{"valid":true,"file":"<absolute path>/skills/plan-to-invoker/fixtures/negative/anti-pattern-g-monolithic-prompt-edit-bridge.yaml"}
```

Verdict threshold: this competing design fails the experiment if it accepts the negative fixture. It is expected to exit `0`, which proves schema validity is not sufficient evidence for implementation-plan policy compliance.

Observed verdict: competing design rejected.

## Decision

Select `skill-doctor.sh` as the deterministic architecture gate for `plan-to-invoker` work. The evidence shows it is executable, documented in both skill surfaces, covered by regression tests, and stricter than schema-only validation on a concrete negative fixture.

The acceptance threshold for INV-63 is met when this file exists at `docs/context/inv-63/experiment-brief.md`, the commands above remain rerunnable from the repository root, and this artifact is committed.
