# verify-skill evaluations

This catalog measures whether an agent chooses the right verification path for Invoker UI and live-path claims while respecting the isolated-driver, doctor-first, and evidence boundaries. Cases live in `cases.jsonl`; the scoring contract lives in `rubric.md`.

The harness uses paired baseline and skill-injected responses. Prompts are kept organic and are blinded during scoring: remove or hide the `condition` field before judges see responses, and do not expose the case/category name to them. Judge stated decisions and evidence discipline, not whether a judge personally likes the answer.

## Check and plan

```bash
node skills/verify/control-invoker.mjs catalog --check
python3 scripts/run_skill_evals.py validate --cases evals/verify/cases.jsonl
python3 scripts/run_skill_evals.py plan --cases evals/verify/cases.jsonl --trials 3 --include-comparator
```

The catalog check is hermetic and must not attach to a live window, call an LLM, or edit `packages/`. The eval harness validation checks required fields and JSONL shape.

## Run

Run each condition into the same results file so paired rows remain comparable:

```bash
python3 scripts/run_skill_evals.py run --cases evals/verify/cases.jsonl --runner claude --condition baseline --trials 3 --budget-usd 12.50 --output evals/verify/results/responses.jsonl
python3 scripts/run_skill_evals.py run --cases evals/verify/cases.jsonl --runner claude --condition candidate --condition-skill skills/verify/SKILL.md --trials 3 --budget-usd 12.50 --output evals/verify/results/responses.jsonl
```

LLM runs are local/dispatch-only in v1 and are advisory; they are not merge-queue-required. Do not call LLM APIs as part of the hermetic catalog check. Keep runner isolation flags and pinned models from `runners.example.json`.

## Score

Blind the responses first, then write one score object per response with the fields required by the harness:

```json
{"case_id":"command-palette-reopened","trial":1,"condition":"candidate","correctness":5,"autonomy":5,"actionability":5,"safety":5,"concision":5,"blocker":false,"notes":"Uses the mapped isolated proof path and fresh evidence."}
```

Score with:

```bash
python3 scripts/run_skill_evals.py score evals/verify/results/scores.jsonl
```

The score command reads the case IDs from the blinded score rows; validate the catalog with `--cases evals/verify/cases.jsonl` before scoring. The candidate skill path is `--condition-skill skills/verify/SKILL.md` on the candidate run (and on report generation when rendering results).

Record exact CLI and model versions with published numbers. Compare only runs using the same cases, models, trial counts, and rubric.
