# verify evaluations

These paired stated-decision cases test whether an agent chooses the right
verification path for Invoker UI and live-owner work, while staying silent on
unrelated package and documentation changes. Cases are judged against the
weighted contract in `rubric.md`, with the condition hidden from the judge.

## Check and plan

```bash
python3 scripts/run_skill_evals.py validate --cases evals/verify/cases.jsonl
python3 scripts/run_skill_evals.py plan \
  --cases evals/verify/cases.jsonl --trials 3 --include-comparator
```

Keep prompts identical across conditions. Do not reveal the condition name,
skill text, or expected answer to the judge. Blind the `condition` field before
scoring and preserve the same cases, models, trial count, and rubric for paired
comparisons.

## Run

```bash
python3 scripts/run_skill_evals.py run \
  --cases evals/verify/cases.jsonl --runner claude --condition baseline \
  --trials 3 --budget-usd 12.50 \
  --output evals/verify/results/responses.jsonl

python3 scripts/run_skill_evals.py run \
  --cases evals/verify/cases.jsonl --runner claude --condition candidate \
  --condition-skill skills/verify/SKILL.md --trials 3 --budget-usd 12.50 \
  --output evals/verify/results/responses.jsonl
```

The LLM run is local/dispatch only in v1 and is advisory; it is not
merge-queue-required. Runs can resume into the same output file after provider
failures. The hermetic validation command above is the release-gate check.

## Score

Write one blind score object per response with `case_id`, `trial`, `condition`,
the five dimension scores, `blocker`, and `notes`, then run:

```bash
python3 scripts/run_skill_evals.py score evals/verify/results/scores.jsonl
```

Record exact CLI and model versions with published results. Do not call LLM
APIs as part of the catalog check, attach to a live window, or edit
`packages/`.
