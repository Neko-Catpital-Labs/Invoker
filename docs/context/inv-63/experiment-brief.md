# INV-63 Experiment Brief

## Goal
Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Files Under Test
- skills/plan-to-invoker/SKILL.md
- .cursor/skills/plan-to-invoker/SKILL.md
- skills/plan-to-invoker/scripts/skill-doctor.sh

## Selected Approach
Use repository-local deterministic validation through skills/plan-to-invoker/scripts/skill-doctor.sh as the proof surface. This keeps the experiment tied to versioned files under test and makes pass/fail output reproducible in isolated runs.

## Competing Design
A grep-only inspection could confirm that expected phrases exist in SKILL.md files, but it would not exercise schema validation, task atomicity, parse-results handling, or the combined validation contract exposed by skill-doctor.sh. Verdict: reject grep-only as insufficient proof for INV-63.

## Deterministic Commands
1. Confirm concrete files under test exist:
   ```bash
   test -f skills/plan-to-invoker/SKILL.md
   test -f .cursor/skills/plan-to-invoker/SKILL.md
   test -f skills/plan-to-invoker/scripts/skill-doctor.sh
   ```
   Expected output: no stdout and exit code 0 for each command.

2. Confirm skill-doctor advertises deterministic validation behavior:
   ```bash
   bash skills/plan-to-invoker/scripts/skill-doctor.sh --help | grep -E "skill-doctor|skip-validation|skip-atomicity|source-file"
   ```
   Expected output: at least one matching help line for each required option family; exit code 0.

3. Confirm both skill entrypoints reference the deterministic doctor surface:
   ```bash
   grep -F "skill-doctor.sh" skills/plan-to-invoker/SKILL.md
   grep -F "skill-doctor.sh" .cursor/skills/plan-to-invoker/SKILL.md
   ```
   Expected output: each grep prints at least one line; exit code 0.

## Thresholds
- All file existence checks must exit 0.
- The help check must expose the doctor command and the option families used for validation control.
- Both skill documents must reference skill-doctor.sh directly.
- Any nonzero exit code is a failed experiment.

## Verdict
Selected: repository-local skill-doctor validation. Rejected: grep-only proof. The selected approach provides deterministic command evidence tied to the concrete files under test while covering the combined validation path reviewers need to assess INV-63.
