---
name: loop-generator
description: >
  Generate a reusable loop instruction doc, loop driver script, and Invoker
  workflow from an interview. Trigger: "loop generator", "generate a loop",
  "invoker-loop-generator", "/invoker-loop-generator", or requests to build a
  reusable babysit/watch/retry loop. For benchmark/direct-output prompts with
  "Required output path", write the requested artifact directly to that literal
  path, do not ask clarifying questions, and do not validate, review-gate, or
  submit.
---

# loop-generator

Repo skill. Generate three artifacts from one interview:

1. a loop instruction doc,
2. a loop driver shell script,
3. an Invoker workflow YAML.

Starting assumptions unless the user says otherwise:

- Repo skill, not a personal-only helper.
- Entry surface can be this skill or the installed `/invoker-loop-generator` command.
- The loop is generic, not PR-only.
- Borrow Invoker-style `Goal`, `Motivation`, success rules, and explicit failure rules.
- Generate the loop doc, driver, and Invoker YAML together.
- Default submission mode is `review_then_submit`.
- Output location is chosen during the interview; if it stays unresolved after one concise question, default to `planning_artifacts` and record that in assumptions.
- `write_mode` is always explicit. Never imply writes from the surrounding task.

## Benchmark/direct-output mode

Use this early-exit mode only when the prompt is a headless benchmark or literal-path request such as `Required output path: /abs/path/file.yaml` or `Write the final artifact to ...`.

In benchmark/direct-output mode:

- Treat each literal absolute output path in the prompt as authoritative.
- Write the requested artifact exactly there.
- Use the provided prompt text as the source of truth. Do not ask clarifying questions.
- Do not scan the repo, references, formulas, or scripts unless the prompt explicitly asks for them.
- Do not run `skill-doctor`, `invoker_validate_plan`, `invoker_submit_plan`, or submit commands.
- Do not self-review or wait for approval gates. Write the requested output and stop.
- Keep the real-world write mode explicit inside the generated artifact.

## Conversational mode (default)

Treat this as a conversation before a draft.

- Talk through edge cases, corner cases, architecture, and ambiguity with the human.
- Resolve those points before producing artifacts.
- If anything important is unclear, ask concise questions instead of drafting.
- Draft only after the human asks you to draft/proceed, or after the conversation has already resolved the important choices and the human gives explicit draft authorization.
- A short confirmation such as `draft it`, `proceed`, or `yes, draft` counts only when it answers a prior draft question.

Ambiguity policy:

- Explore first.
- If multiple real choices remain, ask.
- If only one boring default remains, continue and record it under `Assumptions` in the generated loop doc.
- Mirror the land-stack rule: confirmation is required only when materially different valid choices remain after exploration.

## Required interview schema

Collect and resolve every field below before drafting any artifact. Do not improvise a different schema.

1. `loop_name` — short human name.
2. `loop_slug` — kebab-case slug used in generated filenames.
3. `goal` — one-sentence end state.
4. `motivation` — why the loop exists.
5. `target_scope` — what entities the loop watches.
6. `target_discovery_command` — the exact command(s) or read-only query surface that define the live target set.
7. `target_identity_key` — the field used to dedupe targets.
8. `success_criteria` — exact conditions that count as success.
9. `human_only_blockers` — conditions the loop should surface once and stop retrying.
10. `evidence_sources` — ordered richest-to-cheapest sources the loop must consult before code changes.
11. `fail_condition_rule` — repeated-attempt threshold and grouping key. Default to the existing `(kind,key,head)`-style threshold only when the user does not supply a different rule.
12. `local_proxy_command` — the safest repeatable local/proxy verification command, or `none`.
13. `write_mode` — one of `diagnostic_only`, `worker_owned_writes`, or `choose_each_run`.
14. `output_location_mode` — one of `repo_artifacts` or `planning_artifacts`.
15. `submission_mode` — one of `review_then_submit`, `generate_only`, or `submit_immediately`.

Interview rules:

- Ask for missing `success_criteria` before drafting. Do not infer it from a vague goal.
- Ask for missing `output_location_mode` before drafting. If it remains unanswered, default to `planning_artifacts` and record that assumption.
- Ask for missing edge cases when `human_only_blockers`, `evidence_sources`, `fail_condition_rule`, or `write_mode` would materially change behavior.
- If the prompt names PR creation or publication work, read `skill://make-pr/SKILL.md` before authoring reviewable YAML.
- If the workflow needs multiple review slices, read `skill://review-compression/SKILL.md` before authoring reviewable YAML.

Before drafting, post a short resolved summary with:

- the filled interview fields,
- any defaults taken,
- open questions if any remain,
- a direct draft check such as `Ready to draft the artifacts?`.

Do not draft until draft authorization is explicit.

## Generated artifacts and file naming

Always generate these three artifacts from the resolved interview:

1. loop instruction markdown,
2. driver shell script,
3. Invoker workflow YAML.

### Output paths

`repo_artifacts` writes:

- `plans/<loop_slug>-loop.md`
- `scripts/<loop_slug>-driver.sh`
- `plans/<loop_slug>.yaml`
- `plans/<loop_slug>-step-N.template.yaml` when a workflow chain is required

`planning_artifacts` writes:

- `plans/generated-loops/<loop_slug>-loop.md`
- `plans/generated-loops/<loop_slug>-driver.sh`
- `plans/invoker-handoff.yaml`
- `plans/invoker-handoff-step-N.template.yaml` when a workflow chain is required

Always also write the canonical review artifact to `plans/invoker-handoff.md`, even in `repo_artifacts` mode.

`plans/invoker-handoff.md` must include:

- the resolved interview answers,
- the generated loop doc content,
- the generated driver script content,
- the chosen `output_location_mode`,
- any assumptions/defaults that were applied.

## Loop instruction doc contract

Use `LOOP.md` as the discipline reference. The generated loop doc must keep this exact section order:

1. `Goal`
2. `Real target`
3. `Success invariants`
4. `Fail condition`
5. `Evidence sources`
6. `Local proxy`
7. `Rebuild + rerun`
8. `Loop`
9. `Exit conditions`
10. `Constraints`

Loop doc rules:

- Make the real-world write mode explicit in the doc.
- Keep `Goal`, `Motivation`, success rules, fail rules, and blockers concrete.
- Record assumptions explicitly instead of hiding them.
- Reuse the `ordered evidence sources before edits` pattern from `scripts/repro/repro-admin-bypass-non-landing-root-cause.py`.
- Do not hide mutable-state risks. Say what the live target is, how it is rebuilt each round, and how the loop dedupes it.

## Driver shell script contract

Use `loop-driver.sh` as the behavior reference. The generated driver must:

- parse `--skip-local-check`, `--target <id>` repeatable, `--state-file <path>`, `--repo <owner/repo>`, and `--help`;
- print loop context: `pwd`, branch, repo, and ledger/state-file path;
- rebuild the live target set from `target_discovery_command` every run;
- dedupe the target set by `target_identity_key`;
- print a repeated-failure summary keyed by `fail_condition_rule`;
- when `--target` is passed, run the user-supplied safe dry-run or inspection command against a copy of mutable state, never the live state file;
- when `--skip-local-check` is not set and `local_proxy_command != none`, run the local proxy command and exit non-zero on failure;
- print a final reminder that loop success is defined by the selected `write_mode`, not by manual cleanup.

Driver safety rules:

- The inspection path must copy mutable state before any dry-run or probe command.
- Never let the driver silently widen from read-only inspection into live writes.
- If the target set comes from multiple commands, merge them, then dedupe by `target_identity_key`.

## Invoker YAML generation

Route through the existing handoff pipeline. Do not invent a second submission system.

- Always write the planning handoff artifact to `plans/invoker-handoff.md`.
- Convert the approved handoff artifact into `plans/invoker-handoff.yaml` or a chain of `plans/invoker-handoff-step-N.template.yaml` files.
- Reuse `skills/plan-to-invoker/references/schema.md` and `skills/plan-to-invoker/references/task-patterns.md` for task structure.
- Every generated task gets `id`, `description`, exactly one of `command` or `prompt`, and `dependencies`.
- Every implementation-style prompt task must include `Files:`, `Change types:`, `Acceptance criteria:`, `Layer:`, `Feature state:`, `Review claim:`, `Review lane:`, `Safety invariant:`, `Slice rationale:`, `Architectural effect:`, `Goal:`, `Motivation:`, `Alternative considerations:`, `Implementation details:`, and `Non-goals:`.
- Every prompt must assume zero-context execution and include deterministic pass/fail expectations.

### Formula and stack selection

Spell out the shape. Do not leave it implicit.

- If the generated workflow is one review slice with one implementation prompt plus verification, render a single YAML from the `bugfix` formula in `skills/plan-to-invoker/formulas/bugfix/formula.yaml`.
- If the generated workflow spans more than one review slice, more than one implementation prompt, or distinct proof/behavior layers, render a chain from `skills/plan-to-invoker/formulas/implementation-stack/formula.yaml`.
- Later chain files must use `__UPSTREAM_WORKFLOW_ID__` placeholders and only validator-safe upstream gates.
- Do not generate `ci_failed` external gate policies.
- Use only `completed` or `review_ready` gate policies.

## Validation and submission behavior

Normal harness / installed-command mode:

- Default `submission_mode` is `review_then_submit`.
- Generate artifacts first.
- Validate the resulting `plans/invoker-handoff.yaml` with `invoker_validate_plan`.
- In an Invoker checkout, also run `bash skills/plan-to-invoker/scripts/skill-doctor.sh plans/invoker-handoff.yaml`.
- Present the generated artifacts for review.
- Submit only on an explicit follow-up request.
- On submit, call `invoker_submit_plan` with mode `live`.

`submission_mode` handling:

- `review_then_submit` — default. Generate, validate, summarize, wait.
- `generate_only` — generate and validate, but never submit.
- `submit_immediately` — submit right after validation passes, except in Slack conversational planning mode.

Slack conversational planning mode:

- Never self-submit.
- Never call `invoker_submit_plan`, `invoker_validate_plan`, or CLI submit commands from the thread.
- Preserve the existing standalone confirmation line exactly:

Reply `submit` to submit it.

## References

Use these repo assets as references, not as hidden assumptions:

- `LOOP.md` — loop doc discipline and success/failure framing.
- `loop-driver.sh` — driver flags, live-target summary, repeated-failure summary, and state-copy safety patterns.
- `scripts/repro/repro-admin-bypass-non-landing-root-cause.py` — ordered evidence sources before edits.
- `skills/plan-to-invoker/SKILL.md` — Markdown to YAML to validation to submit pipeline.
- `skills/plan-to-invoker/references/schema.md` — required YAML fields.
- `skills/plan-to-invoker/references/task-patterns.md` — task decomposition and zero-context prompt rules.

## Deliverable boundary

Keep this slice self-contained.

- Do not wire this skill into `packages/app/src/in-app-planner.ts`.
- Do not wire this skill into `packages/surfaces/src/slack/plan-conversation.ts`.
- The deliverable is the repo skill, its installed command, and its contract tests.
