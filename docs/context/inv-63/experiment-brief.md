# INV-63 deterministic experiment brief

## Goal

Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Files under test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected approach

Use `skill-doctor.sh` as the single deterministic proof entrypoint for plan-to-invoker behavior. This keeps validation evidence reviewable because one command reports the same validation surface that plan authors are expected to trust.

## Competing design

A competing design would document separate ad hoc checks for assumptions, schema validation, atomicity, and parse-result validation. That design gives reviewers narrower failure output, but it weakens the architecture by making proof depend on manually remembering the full check set and its order.

## Experiment commands

Run from the repository root:

```bash
test -f skills/plan-to-invoker/SKILL.md
test -f .cursor/skills/plan-to-invoker/SKILL.md
test -f skills/plan-to-invoker/scripts/skill-doctor.sh
grep -n "skill-doctor.sh <plan-file>" skills/plan-to-invoker/SKILL.md
grep -n "skill-doctor.sh" .cursor/skills/plan-to-invoker/SKILL.md
grep -n "Exit codes" skills/plan-to-invoker/SKILL.md
```

## Expected outputs

- Each `test -f` command exits with status `0`.
- The primary skill document contains a `skill-doctor.sh <plan-file>` command reference.
- The cursor skill document contains a `skill-doctor.sh` command reference.
- The primary skill document states deterministic exit-code expectations.

## Verdicts

- Pass: all file checks pass and every grep command returns at least one matching line.
- Fail: any required file is missing, the doctor command is not documented in either skill surface, or exit-code expectations are not documented.

## Thresholds

The experiment threshold is binary and deterministic: `6/6` commands must exit with status `0`. Any lower result blocks treating INV-63 proof as established.
