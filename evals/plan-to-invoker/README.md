# plan-to-invoker evaluations

Ported from the `i-have-adhd` project's `evals/` harness (`scripts/run_evals.py` there,
`scripts/run_skill_evals.py` here). Same paired baseline/candidate design: run the same task
prompt with and without the skill's instructions injected, judge the real responses on a
weighted rubric, and gate a release on the candidate actually being better — not just different.

This complements `scripts/test-plan-to-invoker-skill.sh`, which checks that specific text still
exists in specific files (static contract tests, no model calls). This harness checks something
that script cannot: does the skill's text actually change what the agent decides to do, and is
that decision better. Cases live in `cases.jsonl`; the scoring contract lives in `rubric.md`.

Every runner call here uses `--tools ""` (claude) so responses are judged purely as *stated
decisions* — "what would you do next" — not real tool execution. That mirrors how the source
project's `agent-owned-edit` case works, and matches this skill's own real side effects (writing
`plans/invoker-handoff.yaml`, calling `skill-doctor.sh`, submitting to Invoker) being too costly
and stateful to run for real on every eval trial.

## Validate and plan

```bash
python3 scripts/run_skill_evals.py validate
python3 scripts/run_skill_evals.py plan --trials 3 --include-comparator
```

## Run

Run each condition into the same results file. Candidate and comparator instructions are injected
from the supplied skill file; task prompts remain identical.

```bash
python3 scripts/run_skill_evals.py run \
  --runner claude \
  --condition baseline \
  --trials 3 \
  --budget-usd 12.50 \
  --output evals/plan-to-invoker/results/responses.jsonl

python3 scripts/run_skill_evals.py run \
  --runner claude \
  --condition candidate \
  --condition-skill skills/plan-to-invoker/SKILL.md \
  --trials 3 \
  --budget-usd 12.50 \
  --output evals/plan-to-invoker/results/responses.jsonl
```

The default Claude runner reports dollar cost and receives the remaining condition budget on
every call. Runners without cost reporting are rejected unless `--allow-unmetered` is supplied;
use that flag only when the provider account has its own hard cap.

Both example runners isolate the call from the operator's own agent configuration:
`--setting-sources ""` for Claude, `--ignore-user-config --ephemeral` for Codex. Keep that
isolation when adding runners: without it, user-level plugins, hooks, memory, and output styles
leak into every condition and shape the responses being judged.

Isolation also drops the operator's saved model and effort settings, so the claude runner pins
`--model` explicitly. Keep a pin when editing the runner: without one, the eval silently runs
whatever the operator (or the CLI release) defaults to, and per-token cost varies with it. The
pinned model is part of the result: record it with published numbers.

Runs are resumable: rerun the same command after a provider failure and completed
`(case, trial, condition, runner)` rows are skipped. Each incomplete call is retried twice by
default, and the final provider error is preserved.

## Judge and score

Blind the `condition` field before judging. Write one JSON object per response with these fields:

```json
{"case_id":"scratch-vs-repo-confirm","trial":1,"condition":"candidate","correctness":5,"autonomy":5,"actionability":5,"safety":5,"concision":5,"blocker":false,"notes":"Asks the required question instead of inventing a repoUrl."}
```

Then apply the release gate:

```bash
python3 scripts/run_skill_evals.py score evals/plan-to-invoker/results/scores.jsonl
```

Record the exact CLI and model versions with published results. Do not compare conditions
produced with different cases, models, trial counts, or rubrics.
