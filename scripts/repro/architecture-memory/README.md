# Architecture-memory coding pilot

This directory contains a small offline proof harness for one paired coding
experiment. It does not edit production packages. Trial snapshots are copied
from immutable source commit `0ca415e4d69a3f59a4b666e65f6362adf2d947ad`, edited
in temporary work directories, and graded in fresh evaluator copies.

The existing `scripts/run_skill_evals.py` harness remains response-quality
tooling: its plan-to-invoker mode deliberately disables tools and asks for
stated decisions. This harness is separate because this pilot needs real file
edits, replayable patches, protected grader checks, and preserved failed agent
outcomes.

## Commands

```bash
python3 scripts/repro/architecture-memory/run.py self-test
python3 scripts/repro/architecture-memory/run.py pilot
python3 scripts/repro/architecture-memory/run.py verify-recorded
```

`self-test` validates deterministic controls: source construction, baseline
behavioral equivalence, protected-grader denial, timeout handling, known bad and
known good patches, incomplete/mismatched record rejection, and replay.

`pilot` runs exactly one baseline/treatment pair with randomized order. If a
complete pair is already recorded, it reports the existing record instead of
buying more attempts. Partial attempts are preserved as data and are not retried
automatically.

`verify-recorded` performs no model calls. It rebuilds fresh evaluator copies,
reapplies the recorded trial patches, runs the protected hidden checks, and
verifies source/config/provenance equality.

## What This Pair Measures

The task asks an agent to make one real edit near task-scoped retry handling in
`WorkflowMutationFacade`: when a qualified task id such as `wf-1/task-a` cannot
be resolved through the orchestrator, `retryTask` should still close the owner
workflow review for `wf-1`; an unqualified missing id must not close an arbitrary
workflow.

The treatment is a behavior-preserving fixture patch that factors task workflow
ownership lookup into a local helper. The baseline and treatment snapshots are
built from the same source commit and run with identical runner settings,
instructions, budgets, dependencies, and grader checks.

One pair proves apparatus execution, not an architecture advantage. A later
six-task/five-repeat protocol should reuse this shape with a frozen task set,
predeclared labels, one idempotent ledger per task, and no treatment tuning after
observing failures.

## Invalidation

This pair is invalid if the trial agent can read hidden checks or gold patches,
if the two arms use different runner settings, if a partial trial is rerun as a
fresh attempt, if the treatment changes starting behavior, or if missing cost
telemetry is converted into a dollar-efficiency conclusion.
