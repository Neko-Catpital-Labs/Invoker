# INV-63 Experiment Brief

## Goal
Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Files Under Test
- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected Approach
Use `skills/plan-to-invoker/scripts/skill-doctor.sh` as the primary deterministic proof surface because it aggregates schema validation, assumption extraction, verification-plan generation, task atomicity linting, and parse-results checks behind one pass/fail command.

## Competing Design
A competing design is to invoke individual scripts directly, such as `extract-assumptions.sh`, `generate-verify-plan.sh`, `validate-plan.sh`, `lint-task-atomicity.sh`, and `parse-results.sh`. This exposes smaller failure domains but makes review evidence harder to compare because reviewers must reconcile multiple command outputs and ordering constraints.

## Deterministic Commands
```bash
test -f skills/plan-to-invoker/SKILL.md
test -f .cursor/skills/plan-to-invoker/SKILL.md
test -f skills/plan-to-invoker/scripts/skill-doctor.sh
bash skills/plan-to-invoker/scripts/skill-doctor.sh --help >/tmp/inv-63-skill-doctor-help.txt
grep -E "skill-doctor|Usage|--skip-validation|--skip-atomicity" /tmp/inv-63-skill-doctor-help.txt
```

## Expected Outputs
- Each `test -f` command exits with status `0`.
- `skill-doctor.sh --help` exits with status `0` and writes help text to `/tmp/inv-63-skill-doctor-help.txt`.
- The `grep -E` command exits with status `0` and prints at least one matching line from the help text.

## Verdicts
- Selected approach verdict: accepted when the aggregate doctor command exposes deterministic usage and the three concrete files under test exist.
- Competing design verdict: rejected for INV-63 proof as the default because separately collected script outputs increase review burden without improving the deterministic threshold for this evidence artifact.

## Thresholds
- File existence threshold: all three files under test must exist.
- Command threshold: every deterministic command listed above must exit `0`.
- Evidence threshold: this brief must include Goal, Files Under Test, Selected Approach, Competing Design, Deterministic Commands, Expected Outputs, Verdicts, and Thresholds sections.
