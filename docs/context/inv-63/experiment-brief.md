# INV-63 Experiment Brief

Goal: Establish deterministic experiment proof for INV-63.
Motivation: Ensure architecture choices are evidence-backed and reviewable.
Files under test:
- skills/plan-to-invoker/SKILL.md
- .cursor/skills/plan-to-invoker/SKILL.md
- skills/plan-to-invoker/scripts/skill-doctor.sh

Selected approach: command-only Invoker smoke DAG with deterministic shell checks.
Competing design: prompt-driven implementation workflow with PR publication.
Verdict: selected approach wins for isolated database portability and deterministic review evidence.

Command: test -f skills/plan-to-invoker/SKILL.md
Expected output: exit code 0
Threshold: required
Verdict: pass

Command: test -f .cursor/skills/plan-to-invoker/SKILL.md
Expected output: exit code 0
Threshold: required
Verdict: pass

Command: test -x skills/plan-to-invoker/scripts/skill-doctor.sh
Expected output: exit code 0
Threshold: required
Verdict: pass
