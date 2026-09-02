---
name: plan-to-invoker
description: >
  Convert a plan into an Invoker YAML plan file. After `install-skills`, this
  routing is always on via Cursor `~/.cursor/rules/invoker-execution-precedence.mdc`,
  a Codex AGENTS.md marked block, and a Claude UserPromptSubmit hook.
  One-slice same-repo edits stay local; multi-layer or multi-PR work goes through this
  skill (then chat-submit / auto_submit after the completeness gate) unless the user says "do it locally". Uninstall with `install-skills uninstall`. Trigger: "convert to invoker",
  "submit to invoker", "create invoker plan",
  "invoker-plan-to-invoker", "/invoker-plan-to-invoker", "/plan-to-invoker", or turning a plan file into
  Invoker tasks. For benchmark/direct-output prompts with
  "Required output path", write a complete YAML document directly
  to that literal path; it must start with top-level name, onFinish, mergeMode,
  repoUrl (or scratch: true for no-repo mode), and tasks, never version or metadata wrappers,
  and must not scan, validate, submit, or discover env vars.
---

# plan-to-invoker

Minimal controller skill. Keep policy short here; use deterministic scripts and references for execution details.

## Benchmark/direct-output mode

Use this early-exit mode before the full interactive flow when the request is a headless benchmark or direct-output prompt. Trigger signals include `For this benchmark`, `Do not submit the plan`, `Required output path: <absolute path>`, or `Write the final YAML plan to ...`.

In benchmark/direct-output mode:

- Treat the literal absolute output path in the prompt as authoritative. Write the final YAML plan exactly there.
- Use the provided session, prompt, or plan text as the source of truth. Do not ask clarifying questions.
- Do not run `env`, `printenv`, `set`, repeated shell probes, or `AskUserQuestion` to discover `GENERATED_PLAN` or another output location.
- Do not scan the repository, schema, examples, references, or scripts unless the prompt explicitly asks for those files.
- Do not self-run `skill-doctor`, validation loops, or submit commands. Validation happens outside this direct-output mode.
- After writing the file, print only a short confirmation that includes the path.
- Always include the skeleton's required top-level fields: `name`, `onFinish`, `mergeMode`, `repoUrl` (or `scratch: true` in place of `repoUrl` — see below), and `tasks`.
- The YAML must start with `name:`. Do not use `version:`, `metadata:`, `title:`, or nested wrappers in place of the required top-level fields.
- Treat any YAML found in the session text as source material only, not as the final output. Do not copy partial YAML fragments from the session text.
- Synthesize a fresh complete plan using the skeleton below. The first byte of the file must be the `n` in top-level `name:`.
- A benchmark output that begins with `version:`, wraps fields under `metadata:`, or omits top-level `repoUrl:` is invalid. Do not write it. The same applies when `scratch: true` is used in place of `repoUrl` — one of the two must always be present.
- Before writing, make the first five non-comment top-level keys exactly this envelope order: `name:`, `onFinish:`, `mergeMode:`, `repoUrl:` (or `scratch:` in its place), then `tasks:`.
- When the benchmark prompt says not to submit and forbids external dependencies, generate a command-only verification plan: use top-level task `command:` fields, `dependencies: []`, and `onFinish: none`. Do not generate prompt tasks, nested `steps:`, or implementation tasks that would call an agent or autofix.
- For those isolated benchmark plans, encode the session goal in task descriptions and use deterministic local smoke commands such as `printf` or shell checks that do not assume unprovided artifacts exist. Set `scratch: true` in place of `repoUrl` for these plans, since the tasks never touch a repo.
- If the prompt has Invoker session metadata but no explicit repo URL, and the plan's tasks genuinely need a real repo, use `https://github.com/Neko-Catpital-Labs/Invoker.git` for `repoUrl` without inspecting git remotes.

Compact YAML skeleton for common benchmark plans:

```yaml
name: "<short plan name>"
onFinish: none
mergeMode: manual
repoUrl: "<repo url from prompt>"

tasks:
  - id: "<stable-task-id>"
    description: "<what this task verifies or does>"
    command: "<deterministic shell command>"
    dependencies: []
```

For implementation benchmark plans, switch `onFinish` and `mergeMode` only when the prompt clearly requires a PR/submission workflow, and include task metadata from the prompt itself rather than discovering local references.

## Harness handoff mode

Use this mode when invoked by the installed command or MCP prompt.

> **Not this mode:** Slack `plan:` and agent threads use a separate, orchestrator-owned Slack plan submission path. Do not invoke the CLI or MCP handoff tools from those threads.

### Local vs remote Invoker

Default owner is local (`invoker-cli mcp`). If the current turn names a host, IP, or SSH alias, follow [references/local-vs-remote-mcp.md](references/local-vs-remote-mcp.md) before prepare/submit: probe SSH, rewrite harness MCP only on success, never clobber local on failure. “Local” / “this machine” restores local MCP. Do not invent HTTP/SSE MCP.

- First produce a Markdown planning artifact at `plans/invoker-handoff.md`.
- Convert the approved Markdown plan to `plans/invoker-handoff.yaml`.
- Prefer the MCP review/submission flow when available: call `invoker_prepare_plan_review`, show its ordered steps plus `confirmationText`, then call `invoker_submit_plan` only after approval unless the review result carries `confirmationMode: auto_submit`.
- Before prepare/submit, run `bash skills/plan-to-invoker/scripts/check-planning-completeness.sh <plan-file>` (also part of `skill-doctor`). Incomplete Goal / Motivation / Safety invariant / repoUrl / Verify, or leftover `REPLACE_ME`, must be clarified on the intake surface — do not submit. Any task whose description or prompt carries a `Safety invariant:` heading must also carry a real `Effectiveness measurement:` heading (how success is measured beyond fixture e2e) — missing or placeholder values fail the gate the same way.
- **Baseline evidence claims:** the completeness gate rejects a present-tense claim that the current baseline, suite, tests, or checks are green unless the plan carries fresh evidence. Three authoring forms pass: (1) a trusted `verificationEvidence` receipt (`version: 2`, `trust: trusted`, with an `attestation`) whose `receipt` is a passed `deterministic_command` bound to the plan's `baseCommitSha`, recorded within 24 hours, with `exitCode: 0` and non-empty `output`; (2) a line that starts with `UNVERIFIED:` — the marker must begin the line, an inline `Note: UNVERIFIED: ...` does not qualify the claim; (3) wording that states future intent or a repair dependency instead of a present fact, such as `Keep the suite green after the change.` or `A baseline-repair task must run before the green baseline can be verified.` Planner-supplied receipts without trusted provenance never satisfy the gate.
- In an Invoker source checkout, still run `bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>` before the final submission step.
- Outside an Invoker source checkout, `invoker_prepare_plan_review` is the canonical review surface and `invoker_validate_plan` remains an optional diagnostic, not the approval gate.
- Approval authorizes the reviewed plan's declared `onFinish` outcome. Generated implementation plans default to `onFinish: pull_request`, so approval includes pushing the prepared branch and creating or updating the GitHub PR/stack. `onFinish: none` publishes nothing; `onFinish: merge` authorizes only the merge behavior shown in the reviewed plan. Never broaden beyond that reviewed outcome.
- After `invoker_submit_plan` (or the documented `invoker-cli run ... --live` fallback), do **not** abandon the session: arm `invoker-cli wait <workflowId>` with `notify_on_output` on `^INVOKER_WAKE`, then **end the turn**. On wake, continue the parent job from Invoker status (ops on blockers; complete the reviewed `onFinish` outcome on success).
- Before branch or PR/stack publication implied by `onFinish: pull_request` or `onFinish: merge`, read and follow `skills/make-pr/SKILL.md` (or `skill://make-pr/SKILL.md` when available). This is the publication procedure, not a second authorization gate.
- If the request involves multiple review slices, first read and follow `skills/review-compression/SKILL.md` (or `skill://review-compression/SKILL.md` when available) before writing workflow YAML.

### Self-triggered delegation routing (agents and subagents)

Use `confirmationMode` to distinguish who decided the hand-off should happen:

- **Self-triggered delegation: confirmationMode: auto_submit** — the agent or subagent itself decided, mid-task and without a direct human instruction, that a chunk of work should be handed off to Invoker. No human message asked for this specific hand-off; it's the agent's own routing choice. In this case, skip the Slack review-card wait and call `invoker_submit_plan` once `invoker_prepare_plan_review` reports `confirmationMode: auto_submit` **and** `check-planning-completeness.sh` passed. Incomplete plans stay on the native surface (AskQuestion / Slack question / Linear comment).
- **Human-triggered delegation: confirmationMode: require** — a human's message is the direct request to hand off or send work to Invoker. Today's `require` + human-approval flow is unchanged: show the ordered steps and `confirmationText`, and wait for explicit approval before calling `invoker_submit_plan`. Completeness still must pass first.

In both paths, the delegating agent chooses `poolId` best-effort per `references/schema.md` (an existing field) — omit it for the local default when unsure. `skill-doctor.sh` still runs against the generated plan in both paths; self-triggered delegation changes who approves the submission, not the validation gate.

## Intended flow (do not skip steps)

**Current auto-fix schema:** Never emit `autoFix` or `autoFixRetries` at the plan, workflow, or task level. Those YAML fields are obsolete. Auto-fix retries are configured only with `autoFixRetries` in `~/.invoker/config.json`. A draft containing either YAML field must be corrected and re-run through `skill-doctor.sh`; do not present or submit it.

1. Discuss scope/risk with the user; before authoring YAML, propose each
   `Safety invariant:` and ask the user to confirm or correct it. If the work
   has no repo URL, do not silently pick or invent one — force an explicit
   acknowledgment: confirm with the user whether the plan should use
   `scratch: true` (tasks run in a plain temp directory, no git involved,
   `onFinish: none` + `mergeMode: no_op` required) or a real `repoUrl`.
2. Phase 1a static analysis.
3. Runtime verification (Phase 1b): run the cheapest deterministic command that exercises the behavior, plus Invoker headless when applicable.
4. Generate implementation YAML from verified facts — prefer rendering a matching formula (`skills/plan-to-invoker/formulas/`) and specializing its slots over authoring the shape from scratch.
5. Validate with deterministic scripts.
6. Present plan and submit on confirmation. That confirmation authorizes the reviewed `onFinish` outcome; implementation plans default to GitHub publication through `onFinish: pull_request` without a second approval prompt.

Grep-only checks are Phase 1a only; behavioral claims require executed Phase 1b evidence.

**Deterministic validation gate:** Use `skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>` as the primary deterministic proof surface, backed by `bash scripts/test-plan-to-invoker-skill.sh` for regression coverage. Schema-only validation or ad hoc individual script checks are not sufficient as the review gate, because they can miss strict atomicity, zero-context prompt, policy coverage, and final-gate failures. Individual validator scripts remain fallback diagnostics only; they are not submission proof unless `skill-doctor.sh` has already passed or a waiver is explicitly recorded.

**Review compression (required for implementation plans):** Before authoring any plan with `onFinish != none`, apply `skills/review-compression/SKILL.md`. Split by reviewer cognition, not file count: one local review claim, one review lane, one conceptual unit, one safety invariant, one slice rationale, and one architectural effect per implementation task. Follow its Safety Invariant Confirmation protocol before finalizing the plan. This applies to Invoker and non-Invoker target repos.

**Stack-first authoring (default for implementation plans):** For any plan with `onFinish != none`, default to an authored Invoker workflow stack, not one YAML with many implementation tasks. In Invoker, one YAML file is one workflow; `tasks:` are only tasks inside that workflow. If the implementation has more than one review slice, review lane, conceptual unit, layer, implementation prompt task, package boundary, UI+non-UI boundary, or PR-worthy commit, write multiple `step-N` YAML files and submit them with `scripts/submit-workflow-chain.sh`. Later workflow templates must depend on the previous workflow's merge gate with `externalDependencies` using `workflowId: "__UPSTREAM_WORKFLOW_ID__"`, `taskId: "__merge__"`, `requiredStatus: completed`, and `gatePolicy: review_ready` unless the user explicitly asked for another gate policy.

**Formula-first authoring (recipes):** Before deriving an implementation plan's shape from scratch, check `skills/plan-to-invoker/formulas/` for a recipe that matches (e.g. `bugfix`). A formula locks the workflow shape and the required review/rationale headings so the rendered plan passes `skill-doctor` by construction; you only fill the short `{{var}}` slots and specialize the `REPLACE_ME` prose with verified facts. Render with `bash skills/plan-to-invoker/scripts/render-formula.sh <formula> --var k=v ... --out plans/rendered`, specialize the `REPLACE_ME` lines, then run the normal `skill-doctor` gate on the rendered file(s) before submit. A recipe itself is proven with `bash skills/plan-to-invoker/scripts/formula-doctor.sh <formula>`, which renders it with each var's declared example and requires `skill-doctor` to pass — run it after adding or editing any formula. Reserved stack-wiring tokens (`__UPSTREAM_WORKFLOW_ID__`) are left untouched by the renderer for `submit-workflow-chain.sh`. Prefer a formula when one fits; fall back to from-scratch authoring when none matches.

**Standalone workflow waiver (exception, not default):** A single implementation workflow is allowed only when the whole change is one review claim in one review lane that fits in one implementation prompt task plus verification, or when the user explicitly asks for a single workflow. Any standalone implementation YAML with multiple prompt tasks must include a top-level `description` section headed `Standalone workflow waiver:` explaining why it is not split. Without that waiver, `lint-task-atomicity.sh` rejects multi-prompt standalone implementation workflows.

**Policy-matrix documents:** When the source is an architecture or policy document with a decision table, exception rules, or cross-cutting invariants, you must preserve row-level coverage before authoring workflows. Do not stop at files/functions/packages; every required policy row must map to a workflow step or an explicit waiver.

**Delegated task hints (hard requirement for implementation plans):** For plans with `onFinish != none`, every prompt task must include `Files:`, `Change types:`, and `Acceptance criteria:` sections in `description`. Prompt text must be zero-context executable: assume no prior chat knowledge, include deterministic pass/fail expectations, and keep instructions self-contained. Verify-only plans (`onFinish: none`) keep delegation hints advisory.

**Optional structured freshness:** Freshness metadata is optional. When explicit freshness data is available, add it under the task's `freshness` object with `watchPaths`, `pathPreconditions`, and/or `guardedBehaviorIds`; omit it otherwise. Keep task descriptions as authored prose: structured metadata supplements the prose and does not replace or rewrite it. Do not derive freshness from task prose through post-generation extraction or a semantic regex.

```yaml
tasks:
  - id: implement
    description: Preserve this task prose.
    freshness:
      watchPaths: [packages/app/src]
      pathPreconditions: [{path: packages/app/src, expected: present}]
      guardedBehaviorIds: [plan-authoring]
```

**File-count sizing guidance (soft):** Treat any "about 10 files" guidance as a reviewability heuristic, not a hard constraint. Prefer smaller slices when practical, but allow broader edits when correctness, shared wiring, or coupled refactors require it.

**Dependency-first layered decomposition (required for implementation plans):** For plans whose `onFinish` is not `none`, every implementation task must include `Layer:` and `Feature state:` headings in `description`. Use normalized layer names (`persistence`, `domain`, `transport`, `api`, `contact_surface`, `app_bridge`, `owner_delegation`, `ui_activation`, `app_regression`, `e2e_regression`, `ui`, `docs`) and feature state values (`active` or `dormant`). `dormant` tasks must still include `Acceptance criteria:` in `description`. Verify-only plans (`onFinish: none`) are exempt from this hard requirement.

**Implementation-rationale headings (required for all implementation tasks):** For plans whose `onFinish` is not `none`, every task (prompt or command) must include `Review claim:`, `Review lane:`, `Safety invariant:`, `Slice rationale:`, `Architectural effect:`, `Goal:`, `Motivation:`, `Alternative considerations:` (or `Alternatives:`), `Implementation details:` (or `Implementation:`), and `Non-goals:` in the task `description`. In addition, prompt tasks must include the same rationale headings directly in `prompt` so execution instructions contain explicit intent (not only metadata). This is a hard requirement enforced by `lint-task-atomicity.sh` and `lint-review-units.mjs` so implementation intent is explicit and reviewable in authored workflow YAML.

**Cross-layer dependency direction (required):** Dependency DAGs must flow from lower/foundational layers toward higher/integration layers. If a lower-layer task depends on a higher-layer task, mark an explicit exception in the task description with `Layer exception: allowed` and a rationale.

**Handoff absence gate (hard requirement for implementation plans):** For plans whose `onFinish` is not `none` and that do not set `scratch: true`, `tasks:` must include a shell command task with id exactly `scrub-handoff-artifacts`. That task must depend on every leaf task (any task nothing else depends on) so it runs after every implement/verify task completes, and its `command` must run `scripts/scrub-handoff-artifacts.sh` without `--apply` (or an equivalent read-only handoff-artifact check). The terminal gate may only fail when ephemeral inter-task files (e.g. `candidates.json`, `research-*.json`, `lens-*.json`, `plans/invoker-handoff.{md,yaml}`) remain; it must never delete files, alter the index, or commit caller work. Never point this task at the home Invoker `ledger.json`. `onFinish: none` and `scratch: true` plans are exempt. This is a hard requirement enforced by `lint-task-atomicity.sh`.

**Inter-task file carry (hard):** Downstream Invoker tasks get fresh worktrees from **committed** history only. If task B must see files produced by task A, task A MUST `git add` / `git commit` those paths on the task branch (or both produce+consume must live in one command task). Uncommitted local paths under `work/`, `state/artifacts/`, caches, and similar do **not** flow across task dependencies. Object-store / remote artifact APIs are OK when the plan names them explicitly; silent "same machine path" handoff is not. Prefer a single command that both writes and reads ephemeral local state, or commit an allowed tracked path (for example under `docs/` / `outputs/`) before the dependent task. Enforced as a footgun lint in `lint-task-atomicity.sh` (carve-out: `scratch: true`). See `references/task-patterns.md` § *Inter-task file carry*.

**Bugfix repro:** For bug/regression plans, a shared `bash scripts/repro-<slug>.sh` (or the same `command:` before and after) is **strongly recommended**; **`skill-doctor` does not require it.** If the fix invalidates the original repro, use another explicit verification task. Never reference local-only repo files unless they are already checked into the branch the plan will run on. Use repo-relative paths like `scripts/...`; do not use parent-directory paths like `../../..`. `skill-doctor` rejects repo-relative references to files that exist locally but are not in `HEAD`, rejects parent-directory references, and rejects missing shell scripts used by command tasks, instead of silently treating local-only proof as valid. See `references/task-patterns.md` § *Bugfix repro*.

**Stateful bug lifecycle matrix:** When a bug involves conversation, session, file, cache, or workflow state, Phase 1a must enumerate the transitions that can lose or reuse state. The implementation plan must verify at least one non-happy-path sequence, such as plan creation → intervening message → summary-only reply → authorization/submit. If the state type is shared by multiple surfaces, include a verification case for each affected surface or record why it is unaffected.

**Invoker dogfooding rule:** When the target repo is Invoker itself (`EdbertChan/Invoker` or the upstream `Neko-Catpital-Labs/Invoker`), approved implementation plans use **Mergify Stacks** for their declared GitHub publication outcome: keep `onFinish: pull_request` + `mergeMode: external_review`, then publish/update the resulting commit stack with `mergify stack push`. Do not ask again after the work is ready. Do **not** generalize this to unrelated target repos; for example, `EdbertChan/test-playground` should keep normal PR flow unless that repo independently adopts Mergify Stacks.

**Review-gate artifact intent:** Plans may include optional top-level `reviewGate.artifacts` metadata to describe an ordered review PR stack. Each artifact needs a unique `id`; `required` defaults to `true` when omitted; the first artifact has no dependency; every later artifact must depend on exactly the immediately previous artifact. Do not use fixed PR-count fields or Mergify-specific fields in the plan YAML. This metadata does not affect scheduler readiness, task dependencies, or workflow `externalDependencies`.

## Deterministic step map (plan-to-invoker)

Use these as concrete skill steps. Every step should run a command and produce pass/fail output.

### Primary validation surface

**Run all plan validation checks in one command:**

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>
```

**Exit codes:** 0 = all checks pass, 1 = one or more failures, 2 = usage error
**Output:** JSON summary with per-check pass/fail status

**Optional flags:**
- `--skip-assumptions` — skip assumption extraction and verify plan generation
- `--skip-atomicity` — skip task atomicity linting
- `--skip-validation` — skip YAML schema validation
- `--source-file FILE` — run assumption and coverage checks against a separate source document
- `--coverage-map FILE` — require row-to-workflow traceability for policy-matrix sources
- `--stack-manifest FILE` — require coverage-map workflow labels to match a real authored workflow stack
- `--warn-delegation` — print extra advisory delegation-hint warnings from atomicity lint
- `--verbose` — show detailed output from each sub-check
- `--help` — show usage information

This single command runs: assumption extraction, verify plan generation, YAML validation, strict atomicity linting, and parse-results validation. Use this as the required deterministic pass/fail gate before submitting any plan.
For policy-matrix inputs, it also checks that row-level coverage was extracted and that verify-plan generation did not degrade to `verify-noop`. When validating a plan against a separate policy source, pass `--source-file`, `--coverage-map`, and `--stack-manifest`; policy-matrix inputs now fail without a coverage map and a real authored stack manifest.

When converting from an existing conversation, transcript, or plan document, always pass that original artifact as `--source-file <source>`. If the source already contains a concrete Invoker YAML plan, `skill-doctor` rejects generated plans that drop or replace its task IDs, including generic smoke plans.

For portable command-only smoke plans, avoid nested `sh -c`, `bash -c`, or `bash -lc` quoting when the nested command string contains shell variables such as `$value` or `${value}`. Prefer literal smoke commands like `printf '%s\n' 'Supported: deterministic command-only smoke' && test 1 -eq 1` or `test 1 -eq 1`, or use a direct command without the nested shell wrapper.

Command tasks run under the platform default shell unless the command explicitly invokes another shell. Keep generated commands POSIX-shell portable; if a command needs bash-only behavior such as `set -o pipefail` or `set -euo pipefail`, write it as an explicit bash command, for example `bash -lc 'set -euo pipefail; ...'`.

### Fallback commands (for debugging individual checks)

If `skill-doctor.sh` fails, run individual checks to isolate the problem:

1. `step-extract-assumptions`
   `bash skills/plan-to-invoker/scripts/extract-assumptions.sh <plan-file>`
2. `step-generate-verify-plan`
   `bash skills/plan-to-invoker/scripts/generate-verify-plan.sh "<plan-name>" < assumptions.json > plans/verify-<slug>.yaml`
3. `step-validate-plan`
   `bash skills/plan-to-invoker/scripts/validate-plan.sh <plan-file>`
4. `step-lint-atomicity`
   `bash skills/plan-to-invoker/scripts/lint-task-atomicity.sh <plan-file>`  
  Optional: append `--warn-delegation` to print additional advisory hints. For authored stacks, append `--stack-manifest <file>` so stack slices are validated with stack context. Atomicity lint always runs `--strict-delegation` inside `skill-doctor` and, for implementation plans (`onFinish != none`), hard-fails missing/invalid `Layer:` and `Feature state:` metadata, missing required review-compression/rationale headings in `description` on any task (`Review claim`, `Review lane`, `Safety invariant`, `Slice rationale`, `Architectural effect`, `Goal`, `Motivation`, `Alternative considerations`/`Alternatives`, `Implementation details`/`Implementation`), missing required rationale headings directly in prompt text, cross-layer dependency-direction violations, and (unless `scratch: true`) a missing `scrub-handoff-artifacts` terminal task per the Handoff absence gate above.
5. `step-parse-verify-results`
   `bash skills/plan-to-invoker/scripts/parse-results.sh < /tmp/invoker-verify.txt`
5a. `step-presubmit-traps` (required before any submit; not yet part of `skill-doctor`)
   `node skills/plan-to-invoker/scripts/freshness-check.mjs --ref origin/<baseBranch> . <plan-file>` must print `current` for every prompt task; a `STALE -> needs_input` line is the owner's launch-time verdict, fix the clause before submitting.
   `node skills/plan-to-invoker/scripts/unit-triggers.mjs <plan-file>` must exit 0; on a hit it prints the section line that trips each review unit.
   `grep -n "test -- --run" <plan-file>` must print nothing.
   See `references/task-patterns.md` § *Traps that cost a resubmit*.

### Workflow steps after validation

6. `step-run-verify-plan`
   `./submit-plan.sh plans/verify-<slug>.yaml` (when runtime behavior matters)
7. `step-author-implementation-plan`
   Build implementation YAML from verified facts only.
8. `step-visual-proof` (UI changes only)
   `bash scripts/ui-visual-proof.sh --label before` and `--label after`
9. `step-remote-ci-verify` (high-risk changes)
   `bash skills/remote-ci-verify/scripts/run-remote-ci-verify.sh`
10. `step-submit-standalone-waived` (exception path)
    Use only for verify-only plans, explicitly requested single-workflow plans, or implementation plans that satisfy the `Standalone workflow waiver:` rule.
    `./submit-plan.sh <plan-file>`
    Complete the reviewed `onFinish` outcome after workflow execution. For approved Invoker implementation plans, publish the prepared stack with `mergify stack push` from the working branch after the commits are ready.
10a. `step-submit-stacked` (single plan with upstream dependency)
     **Stacked onto WF-X** means both: `externalDependencies` on WF-X `__merge__` **and** `baseBranch == WF-X.featureBranch`. A concrete extDep alone is gate-only wait, not a branch stack.
     Use when the plan HAS `externalDependencies` with a concrete workflow ID (not `__UPSTREAM_WORKFLOW_ID__`).
     1. Query upstream workflow: `./run.sh --headless query workflows --output json | jq '.[] | select(.id == "<workflowId>")'`
     2. Extract the upstream workflow's `featureBranch`
     3. Rewrite baseBranch: `sed -E -i "s|^baseBranch:.*$|baseBranch: <featureBranch>|" <plan-file>`
     4. Submit: `./submit-plan.sh <plan-file>`
     5. Complete the reviewed `onFinish` outcome. For approved Invoker implementation plans, publish/update the resulting PR stack with `mergify stack push` after submission-side commits are ready.
     Prefer `./scripts/submit-workflow-chain.sh --onto-workflow <WF-X>` (or auto-detect) when submitting a chain whose head attaches to an already-running upstream.
10b. `step-submit-chain` (batch stacking, multiple template plans)
     Default path for implementation work with more than one review slice.
     `./scripts/submit-workflow-chain.sh [--gate-policy completed|review_ready] [--onto-workflow <id>] <plan1.yaml> <plan2.template.yaml> ...`
     The chain script handles: template rendering, baseBranch rewrite, merge-gate injection, sequential submission. When plan[0] has a concrete externalDependency (or `--onto-workflow` is set), it rewrites plan[0] `baseBranch` to that upstream's `featureBranch` before submit — that is what makes the head stacked onto the prior workflow. After execution, complete the reviewed `onFinish` outcome. For approved Invoker-on-Invoker implementation work, publish the prepared chain with `mergify stack push` without another authorization prompt.
     Strict default: when `--gate-policy` is omitted, chain submission enforces `taskId: "__merge__"` + `requiredStatus: completed` + `gatePolicy: review_ready` for upstream workflow dependencies.

## Runtime verification (Phase 1b)

- Focused command lane: run the smallest deterministic command that proves the behavior or assumption. Prefer direct scripts, parser checks, focused builds, or repo-specific repro commands over package-wide test suites.
- Invoker headless lane: run `./submit-plan.sh plans/verify-<slug>.yaml` when flow involves orchestrator/executor/persistence/headless behavior
- Visual proof lane when UI changes apply
- Implementation-plan verification: include focused proof tasks that exercise the changed behavior. Do not require a terminal `pnpm run test:all` gate unless the user explicitly asks for a full-suite gate or the risk calls for it.

When Invoker config enables heavyweight command routing, keep commands in the plan as normal command tasks unless a specific remote target must be declared explicitly. Runtime config may auto-route those commands to SSH.

Authoring YAML is not verification; execution is verification.

## Deterministic scripts

**Primary command surface:**

```bash
bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>
```

Runs all validation checks (assumption extraction, verify plan generation, schema validation, strict atomicity linting, parse-results validation) and produces deterministic pass/fail output. Exit code 0 = all checks pass.

**Individual check commands (for debugging only):**

- Extract assumptions: `bash skills/plan-to-invoker/scripts/extract-assumptions.sh <plan-file>`
- Generate verify scaffold: `bash skills/plan-to-invoker/scripts/generate-verify-plan.sh "<plan-name>" < assumptions.json > plans/verify-<slug>.yaml`
- Generate stack manifest template: `bash skills/plan-to-invoker/scripts/generate-stack-manifest-template.sh coverage-map.json <source-file> > stack-manifest.json`
- Validate schema + dependencies: `bash skills/plan-to-invoker/scripts/validate-plan.sh <plan-file>`
- Lint task atomicity + detail quality: `bash skills/plan-to-invoker/scripts/lint-task-atomicity.sh <plan-file>` (optional: `--warn-delegation`)
- Measure plan quality over time: `references/efficacy-rubric.md`
- Parse verify run output: `bash skills/plan-to-invoker/scripts/parse-results.sh < /tmp/invoker-verify.txt`

## Stacked hardening workflows

For clean PR history, run plan-to-invoker hardening as a dependent workflow chain:

1. `plans/plan-to-invoker-deterministic-step-1-validator.yaml`
2. `plans/plan-to-invoker-deterministic-step-2-doctor.template.yaml`
3. `plans/plan-to-invoker-deterministic-step-3-visual-proof-cli.template.yaml`
4. `plans/plan-to-invoker-deterministic-step-4-fixtures.template.yaml`

Use `scripts/submit-workflow-chain.sh` to preserve dependency order and readable stacked PRs.

When those hardening workflows target Invoker itself, their reviewed `onFinish: pull_request` outcome uses Mergify Stacks (`mergify stack push`) after the commits are ready. Keep external target repos on their own normal PR workflow unless they independently opt into Mergify.

## Routing (see playbook/references)

- File/function-heavy plans: see playbook `playbooks/verify-then-build.md`
- Schema and required fields: `references/schema.md`
- Task decomposition and dependency patterns (code-change plans): `references/task-patterns.md`
- Structured entity research plans (any plan whose deliverable is a fact about a real-world entity — a stock's filing quirk, a legal case's status, a product spec — not a code change): `references/entity-research-patterns.md`. Do not use `task-patterns.md`'s handoff/task-split conventions for these; use this file instead.
- Review compression: `../review-compression/SKILL.md`
- End-to-end examples: `references/examples.md`
- Efficacy / soft scoring: `references/efficacy-rubric.md`

Execution step details: see playbook.
