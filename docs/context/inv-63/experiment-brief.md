# INV-63 Experiment Brief

## Goal

Establish deterministic experiment proof for INV-63 so architecture choices are evidence-backed and reviewable.

## Files under test

- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Selected approach

Use the script-backed `skill-doctor.sh` validation surface as the proof boundary. The architecture choice is to make experiment proof reproducible through local commands with explicit expected outputs and thresholds, then commit this brief as the review artifact.

## Competing design considered

A manual reviewer checklist could inspect the same files and record observations in prose. It is rejected because it does not produce deterministic command output, does not define machine-checkable thresholds, and is harder to rerun during review.

## Deterministic commands

### 1. Surface existence and wiring

Command:

```bash
test -f skills/plan-to-invoker/SKILL.md
test -f .cursor/skills/plan-to-invoker/SKILL.md
test -x skills/plan-to-invoker/scripts/skill-doctor.sh
grep -q "skill-doctor" skills/plan-to-invoker/SKILL.md
grep -q "plan-to-invoker" .cursor/skills/plan-to-invoker/SKILL.md
```

Expected output: no stdout and exit code `0`.

Threshold: all five checks must pass.

Verdict: selected approach is viable only if the skill docs and executable doctor script are present.

### 2. Doctor help is callable

Command:

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh --help | grep -Eq "skill-doctor|Usage"
```

Expected output: no stdout from `grep` and exit code `0`.

Threshold: help output must contain either `skill-doctor` or `Usage`.

Verdict: selected approach has a deterministic local command surface.

### 3. Benchmark artifact content

Command:

```bash
grep -q "Selected approach" docs/context/inv-63/experiment-brief.md
grep -q "Competing design considered" docs/context/inv-63/experiment-brief.md
grep -q "skills/plan-to-invoker/SKILL.md" docs/context/inv-63/experiment-brief.md
grep -q ".cursor/skills/plan-to-invoker/SKILL.md" docs/context/inv-63/experiment-brief.md
grep -q "skills/plan-to-invoker/scripts/skill-doctor.sh" docs/context/inv-63/experiment-brief.md
```

Expected output: no stdout and exit code `0`.

Threshold: the brief must document the selected approach, at least one competing design, and every concrete file under test.

Verdict: the review artifact is complete enough to support INV-63 architecture review.
