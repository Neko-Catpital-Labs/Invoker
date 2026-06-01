# INV-63 Deterministic Experiment Brief

## Goal

Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Files Under Test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected Approach

Use a committed Markdown experiment brief as the review artifact. The brief records deterministic local commands, expected outputs, verdicts, and thresholds beside the implementation context it evaluates.

## Alternative Considered

A transient CI log or local terminal transcript was considered. It was rejected because it is harder to review in a pull request, can disappear outside the local run, and does not keep the architecture decision tied to concrete files under test.

## Deterministic Commands

| Command | Expected Output | Threshold | Verdict |
| --- | --- | --- | --- |
| `test -f skills/plan-to-invoker/SKILL.md` | exit code 0 | file must exist | pass |
| `test -f .cursor/skills/plan-to-invoker/SKILL.md` | exit code 0 | file must exist | pass |
| `test -f skills/plan-to-invoker/scripts/skill-doctor.sh` | exit code 0 | file must exist | pass |
| `grep -q "Benchmark/direct-output mode" skills/plan-to-invoker/SKILL.md` | exit code 0 | canonical skill documents benchmark mode | pass |
| `grep -q "skill-doctor.sh" skills/plan-to-invoker/SKILL.md` | exit code 0 | canonical skill references deterministic doctor command | pass |
| `grep -q "skill-doctor" skills/plan-to-invoker/scripts/skill-doctor.sh` | exit code 0 | doctor script identifies its command surface | pass |

## Review Thresholds

The experiment is accepted when every command exits 0, every file under test is referenced by path, and the selected approach is compared against at least one competing design.

## Verdict

The selected committed-brief approach is preferred because it makes INV-63 proof deterministic, local, and reviewable without depending on external services or ephemeral run records.
