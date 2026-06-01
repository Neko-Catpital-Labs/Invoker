# INV-63 Experiment Brief

## Files Under Test
- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Deterministic Evidence
| File | Lines | SHA-256 |
| --- | ---: | --- |
| `skills/plan-to-invoker/SKILL.md` | 218 | `d39694006136f3ee6daf5a16b22f0563c978bf5964e7f94d6426beecbf76eff8` |
| `.cursor/skills/plan-to-invoker/SKILL.md` | 218 | `d39694006136f3ee6daf5a16b22f0563c978bf5964e7f94d6426beecbf76eff8` |
| `skills/plan-to-invoker/scripts/skill-doctor.sh` | 370 | `93c3ccb5a0440de6f4220a1562c656385203c414943106ee2cd2de335fbb02ec` |

## Commands and Expected Outputs
1. `test -f skills/plan-to-invoker/SKILL.md && grep -n "Benchmark/direct-output mode" skills/plan-to-invoker/SKILL.md`
   Expected: exit 0 and at least one matching line for benchmark/direct-output behavior.
2. `test -f .cursor/skills/plan-to-invoker/SKILL.md && grep -n "plan-to-invoker" .cursor/skills/plan-to-invoker/SKILL.md`
   Expected: exit 0 and at least one matching line proving the cursor-facing skill document is inspectable.
3. `test -f skills/plan-to-invoker/scripts/skill-doctor.sh && grep -n "Usage" skills/plan-to-invoker/scripts/skill-doctor.sh`
   Expected: exit 0 and at least one usage line proving the deterministic doctor entry point is inspectable.
4. `cmp -s skills/plan-to-invoker/SKILL.md .cursor/skills/plan-to-invoker/SKILL.md`
   Expected: recorded verdict is `same content`; either result is acceptable when the architectural choice documents which source is authoritative.

## Thresholds
- All three files under test must exist and be readable.
- The canonical skill file must expose benchmark/direct-output instructions.
- The doctor script must expose a usage surface and be `executable` in this checkout.
- Hashes and line counts above are the reviewable evidence baseline for this experiment run.

## Alternative Considerations
- Selected approach: treat `skills/plan-to-invoker/SKILL.md` as the canonical architecture contract and `skills/plan-to-invoker/scripts/skill-doctor.sh` as the deterministic enforcement surface.
- Competing approach: treat `.cursor/skills/plan-to-invoker/SKILL.md` as the primary source. This is rejected for INV-63 proof because the cursor-facing copy may be an adapter or mirror, while the repository skill path and doctor script form the executable contract under test.

## Verdict
Pass when the commands above exit 0, the evidence table is committed, and reviewers can compare the selected canonical-skill approach against the cursor-facing alternative using the concrete files listed here.
