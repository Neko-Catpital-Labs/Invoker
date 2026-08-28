# Structured Entity Research Plan Patterns

Separate from `task-patterns.md` on purpose. That file governs plans whose deliverable is a **code change**: safety invariant = don't break other code, review lane = correctness of logic. This file governs plans whose deliverable is a **claim about the world** — a fact about a real-world entity, backed by a citation. The first, concrete case this pattern was built from is a stock screen (a 10-K accounting-quirk check, one workflow per ticker), but the pattern generalizes to any entity: a legal case's docket status, a product's spec sheet, a vulnerability's disclosure record, a location's zoning history. Safety invariant there = don't fabricate or misattribute a claim; review lane = is the citation trustworthy and does the record match the source. Different failure modes, different rules. Do not fold this into `task-patterns.md`.

Trigger: the plan's tasks research and record facts about entities — companies, filings, cases, products, or similar — rather than editing product code.

**Scale honesty**: as of this writing, this shape has only been run at scale in one pilot (a stock-screening batch, 41 workflows in one repo). This doc generalizes the pattern preemptively, on the strength of that one pilot's real incident, not because the shape has already recurred across many domains. Use it with that in mind — it's a solid starting point, not a battle-tested-across-domains standard yet.

## Origin of this file: what actually broke

Workflow `wf-1786134278894-20` (ticker CPB, one of 34 identical per-ticker "index-removal and 10-K quirk check" workflows) used a 3-task chain: `gate-check-cpb` (deterministic, writes `.gate/CPB.json`) → `research-quirks-cpb` (AI prompt task, writes `data/stocks/CPB.json` + source excerpt, commits it) → `commit-findings-cpb` (deterministic, supposed to finalize the commit). `research-quirks-cpb` did its job correctly and committed the file. But `commit-findings-cpb` silently rebased onto an *earlier* commit than its own declared dependency — it landed on `gate-check-cpb`'s commit, not `research-quirks-cpb`'s — so from its worktree's point of view there was nothing to commit, and the PR that resulted (#24) merged clean with `data/stocks/CPB.json` missing entirely. No error, no failed check. 33 of the other 34 tickers happened not to hit the race. That's the dangerous part: it's a silent, intermittent, single-digit-percent corruption of an audit trail, not a loud failure.

Root cause (grounded in code, `packages/execution-engine/src/task-runner-prepare.ts:25-36` vs `task-runner.ts:1863-1884` vs `worktree-executor.ts:189-190`): the branch-continuation guard only checks that a completed dependency has a `branch`, not a `commit`; if `commit` isn't populated yet, base resolution silently falls back to the workflow's base branch instead of the dependency's actual output. This is an orchestrator-level gap worth fixing on its own, but the rules below make research plans structurally immune to it regardless of whether/when that gap gets closed.

Note this wasn't even a new pattern to invent — `task-patterns.md` § *Experiment artifact handoff templates* already says an `experiment-write-*` task must "require commit of the artifact in this task." The 3-task split violated a convention this repo already had.

This generalizes beyond stocks; the CPB incident is the reason every rule below exists, not a finance-specific concern.

## Rule 1 (hard): the task that writes a record commits that record, in the same task

Never split "write the data" and "commit the data" into two tasks connected only by a task dependency, when the write is a single small artifact (one JSON record + a source excerpt or two). One task, one worktree, one commit. This closes the CPB failure mode structurally: there is no second task that could rebase onto the wrong ancestor, because there's nothing left for a second task to do.

A separate upstream **gate-check** task (deterministic membership/eligibility lookup, no research) is still fine and often good — it's cheap and keeps expensive research from running on entities that don't qualify. What must not exist is a separate *downstream* commit task after the research/write task.

**Don't hand-write this shape.** Render it:

```bash
bash skills/plan-to-invoker/scripts/render-formula.mjs entity-research \
  --var entity_id=<ID> --var entity_kind="<kind>" \
  --var research_question="<question>" --var record_path=<path> \
  --var source_dir=<dir> --var record_schema_fields="<fields>" \
  --var repo_url=<repo> --out plans/rendered
```

then specialize the `REPLACE_ME` prose in the rendered file. See `formulas/entity-research/entity-research.workflow.yaml` for the exact task shape and required headings (`gate-check-<id>` → `research-write-<id>` → `verify-record-<id>`). Do not hand-copy YAML from this doc into a plan — an earlier draft of this file did exactly that, and its inline examples were missing the review-compression headings (`Review claim:`, `Safety invariant:`, `Slice rationale:`, `Architectural effect:`, `Goal:`, `Motivation:`, `Alternative considerations:`, `Implementation details:`, `Non-goals:`) that `lint-task-atomicity.sh` hard-requires for any task in an `onFinish != none` plan — a doc-only example can silently drift out of `skill-doctor` compliance; a formula can't, because it's exercised by `formula-doctor.sh`.

## Rule 2 (hard): every research task ships a schema, and a re-check task proves it landed

A prompt task saying "write JSON matching this shape" is not a merge gate — it's an instruction the agent can silently fail to follow, exactly like CPB did (its own PR body explicitly said "does not add data/stocks/CPB.json" as a listed non-goal, and the workflow still reached `review_ready`). Two things must both be true:

1. The plan/formula defines the exact JSON contract once, not ad hoc per entity — same field names, types, and enum values for every entity in the batch, so a downstream aggregator can read all of them with one schema. The `entity-research` formula bakes a fixed envelope directly into the template rather than leaving it to prose: every record has `entity_id`, `as_of`, and `claims[]` (each with `value`, `source_excerpt`, `source_url`), plus a `record_schema_fields` var for domain-specific fields on top.
2. A **separate task**, after the write task, re-reads the committed artifact from `HEAD` (not from the agent's self-report) and fails loudly if it's missing or malformed. This mirrors `verify-index-removals-file` from the original index-removal workflow — that pattern already existed for the shared gate file, it just wasn't applied per-entity. The formula's `verify-record-<id>` task is this check.

## Rule 3 (hard): build the table after merge, never before

Don't have any per-entity workflow, or a later task in its own PR, try to assemble the aggregate table. That's the exact situation that made CPB's silent failure invisible until someone went looking file-by-file: 34 parallel branches, no single point where "did every one of these actually land" gets checked. Assembling a table across N in-flight PRs means the table's correctness depends on N branch-chaining operations all going right at once.

Instead, run one more workflow, gated on every per-entity workflow's `__merge__` task via `externalDependencies` (`gatePolicy: review_ready`, same pattern the stack-first authoring rule in `SKILL.md` already uses for sequential PRs — this is a fan-in version, one final workflow depending on N upstream merges instead of 1). Its only task pulls the shared base branch — never any of the per-entity branches — globs the landed records, and regenerates the table as its own small, independently reviewable PR.

Render this shape too, rather than hand-writing it:

```bash
bash skills/plan-to-invoker/scripts/render-formula.mjs entity-research-aggregate \
  --var aggregate_slug=<slug> --var aggregate_summary="<summary>" \
  --var record_glob="<glob>" --var aggregate_output_path=<path> \
  --var aggregate_build_command="<cmd>" --var base_branch=<branch> \
  --var repo_url=<repo> --var upstream_workflow_id_a=<wf-id> \
  --var upstream_workflow_id_b=<wf-id> --out plans/rendered
```

then duplicate the `externalDependencies` block once per additional upstream workflow before submit. See `formulas/entity-research-aggregate/entity-research-aggregate.workflow.yaml`.

Because the aggregator only ever reads the shared base branch, a branch-chaining bug in one of the upstream workflows can no longer corrupt the table by omission without a visible symptom — "row count matches file count" turns a silent gap into a task failure.

**Known limitation: `base_branch` must not be the literal string `master`.** `validate-plan.mjs`'s `stacked_basebranch_default` check (`skills/plan-to-invoker/scripts/validate-plan.mjs:636-645`) hard-fails any plan with concrete `externalDependencies` whose `baseBranch` resolves to `"master"` — it exists to catch a different mistake (a stacked workflow that forgot to point at its upstream feature branch), but it doesn't distinguish that case from this aggregator's correct behavior (gate-only fan-in reading the shared trunk, never a feature branch). For a target repo whose trunk really is named `master` — which includes Invoker itself — the aggregator formula as it validates today needs a real trunk-name alias or a follow-up fix to `validate-plan.mjs` to accept this case; that fix is out of scope here (that script currently has an unrelated in-flight change) and is a named follow-up, not something to work around silently.

This is the standard data-engineering answer to "how do I get a trustworthy summary out of many independently-produced records," not something bespoke to Invoker:

- **Landing / staging / mart, or "bronze / silver / gold"** (the model dbt and most modern data warehouses use): raw primary-source capture (verbatim excerpt files under a per-entity source directory) is append-only and never edited after being committed — it's a citation of what a source said when it was read. One normalized record per entity is the staging layer — each per-entity workflow produces exactly one, and commits it itself (Rule 1). The aggregate table is the mart — built by a separate, deterministic transform step that reads only the staging layer, never the raw capture directly and never in-flight branches.
- **dbt-style tests as a merge gate, not a suggestion**: dbt's `not_null`/`exists`/`unique` tests run against staging models before anything downstream trusts them. Rule 2's re-check task is that pattern applied to a git-committed JSON record instead of a database table.
- **Point-in-time correctness / avoiding look-ahead bias**: quant research desks distinguish "when the underlying event happened" from "when it was known" (a fundamentals restatement, a 10-K filing date) precisely because using data before it was actually knowable silently corrupts backtests. The same discipline applies to any entity-research domain — keep an explicit as-of field on every record, and never let an aggregator silently overwrite a prior snapshot in place. Either date-stamp snapshots (`SUMMARY-2026-08-10.md`) or keep a change log, so the table's history stays reproducible the same way a point-in-time database would be.
- **Screening the graveyard, not just survivors**: researching what got *removed* from a population (an index, a registry, a catalog), not just what's in it today, is a textbook survivorship-bias control — most naive screens only look at current members and silently exclude everything that failed, was delisted, or was retired. Worth calling this out explicitly as the right instinct to keep, not just an implementation detail.

## Anti-patterns

- **Write/commit split**: a research task writes a record; a separate deterministic task is relied on to commit it. (This is exactly what silently dropped CPB.)
- **Self-reported acceptance criteria with no independent re-check**: "the agent said it wrote the file" is not the same claim as "the file is present on `HEAD`."
- **Table-building inside a per-entity workflow or PR**: makes the aggregate's correctness depend on every one of N branches resolving correctly at once, with no single place that would catch a gap.
- **Overwriting a prior snapshot in place**: destroys point-in-time reproducibility — you can no longer answer "what did we know as of last Tuesday."
- **A numeric or verdict claim with no `source_url` + verbatim excerpt file**: every claim must trace back to a primary source, the same way every already-landed record in this batch does.
- **Uniform schema skipped "to save time" on one entity**: an aggregator that has to special-case one entity's shape is a sign the write task didn't follow the contract — fix the write task, don't special-case the reader.

## Known gap: this is undetectable by tooling today

The write/commit-split anti-pattern (Rule 1) is schema-valid and passes `lint-task-atomicity.sh` cleanly — that's *why* CPB's real workflow passed every existing check and still silently dropped data. This doc and the formulas above are the mitigation for now; a generic lint rule that flags a write-then-separate-commit-task shape (mirroring the narrow `experiment-*`/`cleanup-experiment-artifacts-*` triad check that already exists in `lint-task-atomicity.sh` for that one naming convention, generalized to arbitrary task ids) would close the gap at the validator level instead of relying on plan authors to follow this doc. That's a deliberate follow-up, not an oversight — it touches the shared validator every Invoker plan runs through, so it needs its own careful design and negative-fixture coverage rather than riding along with this change.
