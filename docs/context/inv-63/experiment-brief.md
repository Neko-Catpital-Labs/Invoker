# INV-63 experiment brief

## Goal
Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Motivation
Ensure the plan-to-invoker skill, its Cursor mirror, and skill-doctor remain a coherent, testable surface for downstream workflow authoring.

## Files under test
- skills/plan-to-invoker/SKILL.md
- .cursor/skills/plan-to-invoker/SKILL.md
- skills/plan-to-invoker/scripts/skill-doctor.sh

## Deterministic commands
1. test -f skills/plan-to-invoker/SKILL.md
2. test -f .cursor/skills/plan-to-invoker/SKILL.md
3. test -x skills/plan-to-invoker/scripts/skill-doctor.sh
4. grep -q "skill-doctor" skills/plan-to-invoker/SKILL.md
5. bash skills/plan-to-invoker/scripts/skill-doctor.sh --help

## Expected outputs
- Commands 1-3: exit code 0, no stdout required.
- Command 4: exit code 0 confirming skill-doctor cross-reference in SKILL.md.
- Command 5: usage banner printed; exit code 0 or 2 is accepted for --help.

## Verdicts and thresholds
- Pass: 5 of 5 commands meet their expected exit and complete within 60 seconds wall time.
- Inconclusive: any single command exceeds 60 seconds or returns an unexpected exit; re-run with verbose logging before downgrading.
- Fail: two or more commands deviate from expected output; halt and re-open INV-63.

## Alternatives compared
- Selected: command-only verification using file probes plus skill-doctor --help self-check. Deterministic and free of agent dependency.
- Alternative A: prompt-based agent verification. Rejected because outputs vary across runs and are not byte-deterministic.
- Alternative B: end-to-end submit plus pnpm run test:all from repo root. Rejected because it depends on external services and exceeds the isolated benchmark scope.
