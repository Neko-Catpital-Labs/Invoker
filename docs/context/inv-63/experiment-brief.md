# INV-63 Experiment Brief

## Goal

Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Files Under Test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected Approach

Use a dual-tree skill contract plus the deterministic `skill-doctor.sh` validation surface as the proof boundary. This keeps the Codex skill and Cursor skill behavior reviewable while grounding experiment claims in a script that returns stable pass/fail output.

## Alternative Considered

A single-source skill-file review was considered. It is simpler to inspect, but it does not prove that the Cursor-facing skill copy and the executable doctor surface agree with the selected contract. That makes review evidence weaker for INV-63 because architecture drift could pass unnoticed.

## Deterministic Commands

```bash
test -f skills/plan-to-invoker/SKILL.md
test -f .cursor/skills/plan-to-invoker/SKILL.md
test -f skills/plan-to-invoker/scripts/skill-doctor.sh
grep -F "skill-doctor.sh" skills/plan-to-invoker/SKILL.md
grep -F "plan-to-invoker" .cursor/skills/plan-to-invoker/SKILL.md
grep -F "extract-assumptions" skills/plan-to-invoker/scripts/skill-doctor.sh
```

## Expected Outputs

- Each `test -f` command exits with status `0`.
- The Codex skill file prints at least one line containing `skill-doctor.sh`.
- The Cursor skill file prints at least one line containing `plan-to-invoker`.
- The doctor script prints at least one line containing `extract-assumptions`.

## Thresholds

- Required file presence threshold: `3 / 3` files exist.
- Required grep threshold: `3 / 3` fixed-string checks produce at least one matching line.
- Passing status threshold: every command exits with status `0`.

## Verdict

The selected dual-tree plus doctor-script approach passes when all commands above meet their thresholds. The single-source alternative is rejected for INV-63 because it cannot detect drift across the Cursor skill surface and the deterministic validation script.
