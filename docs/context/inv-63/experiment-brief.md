# INV-63 Deterministic Experiment Brief

## Goal

Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Files Under Test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected Approach

Use `skills/plan-to-invoker/scripts/skill-doctor.sh` as the primary deterministic proof surface. It is the selected design because it centralizes the required validation checks behind one command, produces machine-readable pass/fail evidence, and keeps review focused on a single repeatable gate.

## Alternative Considered

A competing design is to run individual validators directly from the skill instructions, such as assumption extraction, schema validation, atomicity linting, and result parsing as separate review commands. This gives finer diagnostics, but it increases reviewer burden and can let a workflow pass after only a partial subset of required checks. The alternative is acceptable for debugging after failure, but not as the primary proof gate.

## Deterministic Commands

| Command | Expected output | Verdict | Threshold |
| --- | --- | --- | --- |
| `test -f skills/plan-to-invoker/SKILL.md` | exit code `0` | Confirms canonical skill instructions exist | Must pass |
| `test -f .cursor/skills/plan-to-invoker/SKILL.md` | exit code `0` | Confirms cursor-facing skill instructions exist | Must pass |
| `test -f skills/plan-to-invoker/scripts/skill-doctor.sh` | exit code `0` | Confirms deterministic doctor script exists | Must pass |
| `grep -F "skill-doctor.sh" skills/plan-to-invoker/SKILL.md` | at least one matching line | Confirms canonical instructions identify the doctor as proof surface | At least one match |
| `grep -F "skill-doctor.sh" .cursor/skills/plan-to-invoker/SKILL.md` | at least one matching line | Confirms cursor instructions identify the same proof surface | At least one match |
| `bash skills/plan-to-invoker/scripts/skill-doctor.sh --help` | usage text and exit code `0` | Confirms the selected proof command is runnable without external services | Must pass |

## Verdict

The selected approach is approved for INV-63 when every command above meets its threshold. If any command fails, the architecture proof is incomplete and the implementation must not rely on undocumented assumptions.
