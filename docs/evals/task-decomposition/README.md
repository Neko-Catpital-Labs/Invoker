# Task Decomposition Experiment Harness

This directory contains a runnable, re-judgeable harness for measuring whether
split task decomposition performs better than a monolithic single-agent prompt
on real Invoker repros.

## Claim Under Test

Task decomposition is Invoker's core bet, but it currently has no measured
efficacy evidence. This harness makes the split-vs-monolithic question
answerable with recorded trial evidence that can be scored again later without
rerunning paid trials.

## Design

The harness has two arms:

- `split`: the prompt asks the agent to plan first and then execute through an
  Invoker task DAG.
- `monolithic`: the prompt asks one agent to solve the same task from one
  prompt without a planned DAG.

The task corpus is intentionally built from real historic repros under
`repro/`, not from synthetic tasks. `tasks.json` enumerates each candidate task
with an id, repro script path, description, and deterministic pass command.
`golden-prompts.md` freezes the exact per-task prompt text for both arms.

`run-trials.mjs` records one immutable JSON line per trial in `trials.jsonl`.
Trial records contain:

- `trial_id`
- `arm`
- `task_id`
- `prompt`
- `output_ref`
- `cost.total`
- `cost.decompose_overhead`
- `cost.autofix`
- `cost.wall_clock_ms`
- `timestamp`

Trial records never contain score fields. Scoring is deliberately separate so
the same paid trial output can be re-judged under a new rubric.

## Safety Invariant

This harness lives under `docs/evals/` and is inert unless invoked directly.
`--dry-run` validates the checked-in task and prompt configuration and prints
the planned trial matrix without invoking any agent, writing any trial record,
or spending tokens.

Non-dry trial execution is adapter-based. `run-trials.mjs` requires
`TASK_DECOMPOSITION_AGENT_COMMAND` for non-dry runs; that command receives a JSON
invocation spec on stdin and writes output on stdout. This keeps the checked-in
harness free of product behavior changes and free of implicit agent calls.

## Run Flow

Validate the full matrix without agent calls:

```sh
node docs/evals/task-decomposition/run-trials.mjs --dry-run
```

Validate one planned cell:

```sh
node docs/evals/task-decomposition/run-trials.mjs --arm split --task real-ssh-error-overwritten --trials 3 --dry-run
```

Run live trials only as a separate explicit action with an adapter command:

```sh
TASK_DECOMPOSITION_AGENT_COMMAND='path/to/agent-adapter' \
  node docs/evals/task-decomposition/run-trials.mjs --arm split --task real-ssh-error-overwritten --trials 3
```

Each live trial appends to `trials.jsonl` and writes its raw adapter output under
`outputs/`. The harness does not score while trials run.

## Re-Judge Flow

Score existing trials under a named rubric version:

```sh
node docs/evals/task-decomposition/score.mjs --rubric-version v1
```

The scorer reads `trials.jsonl` and writes only to
`scores/<rubric-version>.jsonl`. It never mutates `trials.jsonl`.

Each score record is keyed by `trial_id` and contains three grader lanes:

- `frozen_test_suite`: runs the task's deterministic pass command and records
  the exit code.
- `llm_judge`: records the placeholder LLM-judge invocation contract without
  making an LLM call.
- `human_rubric`: records a matching human rubric entry when supplied through
  `--human-rubric`.

## Non-Goals

- No live trials are run by this change.
- No agent invocation is made by dry-run.
- No CI wiring is added.
- No product component is changed.
