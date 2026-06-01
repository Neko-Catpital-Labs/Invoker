# INV-63 — Deterministic Experiment Brief

## Purpose

Establish reviewable, evidence-backed proof that the plan-to-invoker skill ships
with the artifacts cited by INV-63: the canonical skill definition, its
Cursor-installed mirror, and the doctor script that runs single-command plan
validation. Architecture choices for INV-63 must rest on reproducible local
checks, not on assumptions about repository state.

## Files Under Test

- `skills/plan-to-invoker/SKILL.md` — canonical skill definition (frontmatter,
  benchmark/direct-output mode, intended flow, deterministic step map).
- `.cursor/skills/plan-to-invoker/SKILL.md` — Cursor-installed mirror of the
  same skill, kept in lockstep by `scripts/setup-agent-skills.sh`.
- `skills/plan-to-invoker/scripts/skill-doctor.sh` — single-command validation
  entry point that fans out into assumption extraction, verify plan generation,
  schema validation, atomicity linting, and parse-results validation.

## Deterministic Experiments

Each experiment is a single shell command with an exact expected exit code.
Verdict is PASS when the observed `exit=$?` line equals the expected line,
otherwise FAIL. No tolerance is applied; thresholds are exact string matches.
All commands are executed from the repository root.

### Experiment 1 — Canonical SKILL.md is present

Command:

    test -f skills/plan-to-invoker/SKILL.md; echo "exit=$?"

Expected output: `exit=0`
Verdict: PASS if `exit=0`, otherwise FAIL.
Threshold: exact string match on `exit=0`.

### Experiment 2 — Cursor-installed SKILL.md mirror is present

Command:

    test -f .cursor/skills/plan-to-invoker/SKILL.md; echo "exit=$?"

Expected output: `exit=0`
Verdict: PASS if `exit=0`, otherwise FAIL.
Threshold: exact string match on `exit=0`.

### Experiment 3 — skill-doctor.sh exists and is executable

Command:

    test -x skills/plan-to-invoker/scripts/skill-doctor.sh; echo "exit=$?"

Expected output: `exit=0`
Verdict: PASS if `exit=0`, otherwise FAIL.
Threshold: exact string match on `exit=0`.

### Experiment 4 — skill-doctor.sh advertises usage on `--help`

Command:

    bash skills/plan-to-invoker/scripts/skill-doctor.sh --help >/dev/null 2>&1; echo "exit=$?"

Expected output: `exit=0`
Verdict: PASS if `exit=0`, otherwise FAIL.
Threshold: exact string match on `exit=0`.

## Alternative Designs Considered

### Selected: file-system invariant verdicts authored in-tree

A short markdown brief plus four shell commands (`test -f`, `test -x`,
`--help` smoke) checked into `docs/context/inv-63/experiment-brief.md`.

- Pros: zero external dependencies, no network, no fixture files, reproducible
  offline by any reviewer running the four commands, and the diff itself is the
  audit trail. Reviewers can re-run the proof in under one second.
- Cons: only proves presence and executability, not semantic correctness of the
  doctor's individual checks.

### Rejected: scripted golden-output snapshot of skill-doctor

A node script that invokes `bash skills/plan-to-invoker/scripts/skill-doctor.sh`
against a fixture plan and diffs stdout against a checked-in `.snap` file.

- Pros: catches regressions in doctor output formatting and exit-code drift
  beyond mere presence.
- Cons: brittle to whitespace, depends on local node/bash/coreutils versions,
  introduces a fixture plan whose own lifecycle has to be maintained, and the
  snapshot file is itself hard to review in a PR diff (large, noisy). The
  marginal regression-detection signal is not worth the maintenance and
  review-friction cost for an INV-63 evidence artifact.

### Why the selected design wins

The INV-63 goal is reviewable evidence, not continuous regression detection.
The selected design lets a reviewer re-run four commands and read a single
markdown file; the rejected design forces reviewers to reason about a
generated snapshot. Regression detection for the doctor is already owned by
`bash scripts/test-plan-to-invoker-skill.sh` and the doctor's own sub-scripts
(`validate-plan.sh`, `lint-task-atomicity.sh`, `parse-results.sh`).

## Pass / Fail Threshold Summary

| Experiment | Threshold | Verdict gate |
| --- | --- | --- |
| 1 | `exit=0` exact match | Canonical SKILL.md exists |
| 2 | `exit=0` exact match | Cursor mirror SKILL.md exists |
| 3 | `exit=0` exact match | skill-doctor.sh is executable |
| 4 | `exit=0` exact match | skill-doctor.sh advertises `--help` usage |

A run passes only if all four experiments report `exit=0`. Any non-zero exit
from any experiment fails the brief verdict for INV-63.
