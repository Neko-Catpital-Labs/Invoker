# Missing-fields interview example

User request:

> Build me a worker-only PR babysitting loop.

Before drafting, ask for the missing fields that materially change behavior.

Good follow-up:

1. `success_criteria` — What exact outcome counts as success for one target? Example: merged by worker action alone, or surfaced once as human-only.
2. `human_only_blockers` — Which cases should stop after one surfaced explanation instead of retrying?
3. `evidence_sources` — What sources must the loop read before code changes, in order?
4. `write_mode` — Pick one: `diagnostic_only`, `worker_owned_writes`, or `choose_each_run`.
5. `output_location_mode` — Pick one: `repo_artifacts` or `planning_artifacts`.
6. `submission_mode` — Keep default `review_then_submit`, or choose `generate_only` / `submit_immediately`.

Bad follow-up:

- Drafting YAML immediately.
- Guessing `success_criteria` from the goal.
- Omitting the output-location choice.
- Leaving `write_mode` implicit.

Drafting is allowed only after the answers are resolved and the user gives explicit draft authorization.
