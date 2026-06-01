# INV-63 deterministic experiment brief

## Goal

Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Files under test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected approach

Use a committed experiment brief as the review artifact. The brief records local commands, expected output fragments, verdicts, and thresholds before implementation decisions are accepted. This keeps the proof deterministic and attached to the same commit history as the architecture decision.

## Competing design considered

A competing design is to rely on ad hoc reviewer notes or CI transcript links. That is weaker because notes can omit the exact command surface and external transcript links are not durable in isolated benchmark runs. The selected committed-brief approach is preferred because the artifact is local, reviewable, and reproducible without depending on external services.

## Deterministic commands

### 1. Required file presence

Command:

```bash
test -f skills/plan-to-invoker/SKILL.md
test -f .cursor/skills/plan-to-invoker/SKILL.md
test -f skills/plan-to-invoker/scripts/skill-doctor.sh
```

Expected output: no stdout and exit code `0`.

Verdict threshold: pass only when all three files exist.

### 2. Skill files expose benchmark/direct-output mode

Command:

```bash
grep -n "Benchmark/direct-output mode" skills/plan-to-invoker/SKILL.md
grep -n "Benchmark/direct-output mode" .cursor/skills/plan-to-invoker/SKILL.md
```

Expected output: each command prints at least one matching line containing `Benchmark/direct-output mode`.

Verdict threshold: pass only when both skill documents describe benchmark/direct-output behavior.

### 3. Doctor script advertises deterministic pass/fail behavior

Command:

```bash
grep -n "skill-doctor" skills/plan-to-invoker/scripts/skill-doctor.sh
grep -n "exit" skills/plan-to-invoker/scripts/skill-doctor.sh
```

Expected output: matching lines identify the doctor script entry point and explicit exit handling.

Verdict threshold: pass only when the script includes an identifiable doctor surface and explicit exit behavior.

## Architecture verdict

The selected approach is accepted when the required files exist, both skill definitions document benchmark/direct-output mode, and the doctor script exposes deterministic command behavior with explicit exit handling. If any threshold fails, INV-63 lacks sufficient deterministic proof and the architecture decision should not proceed.
