# INV-63 Experiment Brief

## Files under test

- skills/plan-to-invoker/SKILL.md
- .cursor/skills/plan-to-invoker/SKILL.md
- skills/plan-to-invoker/scripts/skill-doctor.sh

## Selected approach

Use skill-doctor.sh as the deterministic proof surface because it exercises the skill policy, generated verification scaffolding, schema validation, atomicity linting, and result parsing from one repeatable command.

## Alternative considered

A grep-only inspection of SKILL.md was rejected as the primary proof surface because it can confirm text exists but cannot prove that the validator chain still accepts or rejects plans deterministically.

## Deterministic commands and expected outputs

| Command | Expected output | Verdict threshold |
| --- | --- | --- |
| `test -f skills/plan-to-invoker/SKILL.md && test -f .cursor/skills/plan-to-invoker/SKILL.md && test -x skills/plan-to-invoker/scripts/skill-doctor.sh` | exit code 0 | all referenced files must exist and skill-doctor.sh must be executable |
| `bash skills/plan-to-invoker/scripts/skill-doctor.sh --help` | usage text mentioning `--skip-assumptions`, `--skip-atomicity`, and `--skip-validation` | required flags must be documented |
| `bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>` | JSON summary with passing checks and exit code 0 for a valid plan | no failed checks; exit code must be 0 |

## Verdicts

- PASS when every deterministic command meets its threshold.
- FAIL when any command exits non-zero, omits expected flag coverage, or reports a failed validation check.
