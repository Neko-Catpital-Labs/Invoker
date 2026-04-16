# Invoker is not just an app. It is a workflow system.

The easiest way to misunderstand Invoker is to think of it as a desktop app that happens to run tasks.

The codebase points to a different story: Invoker is a persisted workflow engine that turns a graph of work into isolated task runs, then composes the results through git branches, merge gates, and review steps.

That distinction matters.

There are already plenty of tools that can execute a command, open a terminal, or ask an AI agent to do one thing. What is still missing in a lot of software tooling is orchestration: a way to coordinate many related tasks, run the independent ones in parallel, keep state durable, and make the result of one task legible to the next one.

That is the problem Invoker is trying to solve.

## What Invoker does

At a high level, Invoker takes a workflow, models it as a DAG, runs the ready tasks in isolated environments, keeps the state of the workflow on disk, and then composes the outputs through git branches and explicit review or merge gates.

The short version looks like this:

1. A person or tool tells Invoker what work should happen.
2. Invoker turns that work into a graph of dependent tasks.
3. Ready tasks are dispatched to isolated workspaces.
4. Results come back as explicit task outputs, usually including branch metadata.
5. Downstream tasks consume those outputs.
6. Workflow completion is handled through merge or review gates instead of being left implicit.

If you want the one-sentence version:

> Invoker is a persisted workflow engine that runs a DAG of work in isolated environments and composes the output through git branches, merge gates, and review policy.

## The systems Invoker borrows from

Invoker is interesting partly because it does not come from nowhere. It clearly adopts ideas from several other systems. But the useful comparison is not “Invoker is Bazel” or “Invoker is Temporal.”

The useful comparison is: *which ideas did it take, and how were they adapted?*

### Bazel: explicit work requests, deterministic identity, invalidation

Bazel's influence shows up most clearly in the worker protocol and in the way execution identity is treated as something derived from inputs rather than invented ad hoc.

In Invoker, the contracts package explicitly describes its worker model as a “Bazel-inspired request/response protocol for task execution.” The orchestrator constructs a `WorkRequest`, an executor performs the work, and a `WorkResponse` comes back.

That does **not** mean Invoker is trying to be Bazel.

The better way to say it is this:

- Bazel treats work as explicit actions with declared inputs and outputs.
- Invoker treats task execution the same way.
- Bazel uses deterministic identity and invalidation when inputs change.
- Invoker adapts that idea to task runs, branch naming, and upstream lineage.

That is why the Bazel comparison is useful. It explains the discipline. It does not mean Invoker is a literal build system or a full Bazel-style artifact cache.

### Airflow: DAGs, operator views, visible lifecycle

Airflow is the easiest comparison for people who have operated data pipelines before.

Invoker workflows are DAGs. Tasks have visible states. There is a scheduler. There are graph and timeline views. There are retries, blockers, and human checkpoints.

That is very Airflow-shaped.

But again, the comparison is about operating model, not identity.

Invoker is not trying to be a data pipeline framework. It is using the DAG model because DAGs are a very good way to express dependent work, and because operator-facing graph views are one of the best ways to make a running system understandable.

### Temporal: durability and workflow control

Temporal is the best comparison for how Invoker thinks about durable workflow state.

Invoker persists workflow and task state. It allows multiple clients to talk to the same core engine. It supports human-in-the-loop interaction through commands like approve, reject, provide input, and select experiment.

That is where the Temporal comparison helps.

It helps less if the comparison starts implying that Invoker has Temporal's programming model. Invoker does not claim Temporal-style workflow code replay, and it does not expose a direct Signals API equivalent. The closest match is command submission through the orchestrator path.

So the right statement is: Invoker borrows from Temporal's durability and control-plane ideas more than from its workflow programming semantics.

### CI/CD systems: isolation, approvals, runner types, pull requests

CI systems like GitHub Actions have already trained people to think in terms of branch isolation, runner selection, fan-out work, approvals, and PR gating.

Invoker clearly adopts that operational language:

- different executor types act like different runner classes
- approvals are built into workflow progression
- branch-per-task isolation is a first-class idea
- PRs and merge gates are part of the workflow rather than an afterthought

This is one of the reasons Invoker feels familiar so quickly. Even when the underlying implementation is different, the user-facing control model already resembles patterns people know from CI/CD.

## What makes Invoker distinct

The most distinctive part of Invoker is not the DAG and not the worker protocol.

It is the choice to use git itself as the execution substrate.

That single decision changes a lot:

- a task often produces a branch rather than just a pass/fail bit
- a downstream task consumes upstream branches rather than merely reading upstream status
- merge and review are explicit workflow states
- conflicts become workflow events instead of informal cleanup work at the end

That is what makes Invoker feel different from a normal task runner.

It is not only orchestrating *that* work happened. It is orchestrating how code changes move through isolation, composition, and approval.

![How Invoker works overview](./invoker-architecture-overview.png)

## If you only want the non-technical version, you can stop here

At a product level, the pitch is simple:

Invoker treats software work the way build systems and workflow engines treat structured computation: as a graph of explicit steps with durable state, isolated execution, and observable transitions.

That is the part most readers need.

The rest of this article is the deeper version for people who want to know what that looks like in the actual codebase.

## The deeper version

### 1. The orchestrator is database-first

The strongest architectural signal in the repo is that the database is meant to be authoritative.

The header comment in `Orchestrator` says all writes go through the persistence layer first, and that the in-memory graph is refreshed from the database so the database remains the single source of truth.

That is a very important choice.

It means Invoker is designed so that “what happened” can be reconstructed from persisted state, rather than from half-memory, half-process-local state.

### 2. The mutation path is intentionally narrow

Invoker does not want every feature to mutate workflow state however it wants.

`CommandService` exists specifically to serialize orchestrator-level mutations, and its own header comment says concurrent mutations should never interleave.

That matters because Invoker does allow concurrency in execution. Multiple tasks can run at once. But graph mutation is intentionally more conservative. The system is basically saying: execution may be parallel, but the meaning of the workflow should stay orderly.

### 3. The graph is not decorative

The graph package describes itself as owning workflow task graph and dependency structures, with responsibility for pure graph operations and traversal.

That sounds small, but it is actually one of the clearest signs of architectural intent.

In a lot of systems, the graph is just how the UI draws boxes.

In Invoker, the graph is part of runtime meaning. Readiness, blocked state, and staleness are derived from graph relationships and attempt lineage, not just from whatever flag happened to be toggled most recently.

### 4. Execution is isolated by default

Invoker supports multiple execution environments, including local worktrees, Docker, and SSH workspaces.

That is not just a convenience feature. It is part of the correctness model.

The default posture is that a task should get its own isolated workspace instead of mutating the host repo directly. The execution-engine README also documents a hardline rule that executors fetch from `origin` before starting a task and abort if that fetch fails, rather than silently continuing on stale state.

That is another sign of the same philosophy: prefer explicit failure to invisible drift.

### 5. Persistence has a single-writer rule

This is one of the more important architectural details, even though it sounds like implementation trivia at first.

Invoker uses sql.js-backed SQLite. The repo's persistence architecture document explains why that matters: multiple writable processes can flush stale in-memory snapshots back to disk and overwrite each other's changes. So Invoker enforces a single-writer owner model and makes non-owner processes delegate mutations instead.

That is not just “how the database works.” It is an actual system invariant.

### 6. Branches are real outputs

One of the best small details in the code is that `TaskRunner` guards against missing branch metadata for completed dependencies. The comment makes the reason explicit: without branch metadata, downstream work could run against the base branch and silently drop upstream implementation changes.

That one guard reveals a lot about Invoker's worldview.

The output of a task is not just “status: completed.” The output is something a downstream task can compose with, and in practice that usually means a branch plus the associated attempt context.

## How Invoker is written

The repo does not have one short style guide that says “here is the philosophy.” Instead, the philosophy emerges from architecture rules, code comments, and repo instructions.

Taken together, they point to a pretty consistent coding style.

### Make state explicit

The orchestrator's database-first model is the clearest example, but the style shows up elsewhere too. The system prefers explicit task state, explicit attempt identity, explicit workspace metadata, and explicit gates.

That is the opposite of “just keep some state in memory and hope the ordering works out.”

### Keep mutation paths narrow

The presence of a dedicated serialized command service is a style statement as much as an implementation detail. It shows a strong preference for one narrow mutation path over many convenient ones.

### Keep graph logic separate from execution logic

The graph package is intentionally described in pure terms, while the execution engine is separately responsible for process lifecycle and execution constraints.

That boundary is important because it keeps “what is valid” separate from “how work runs.”

### Enforce package boundaries

The root `ARCHITECTURE.md` is very explicit about package layers, forbidden dependency directions, and enforcement through checks like `dependency-cruiser` and type checking.

That suggests a codebase that sees architectural boundaries as something to enforce mechanically, not just discuss philosophically.

### Demand executable verification

The repo instructions in `CLAUDE.md` insist on real verification commands and prefer `pnpm test` over vague or tool-fragile alternatives.

That is another consistent theme: if a claim about the system matters, there should be a concrete way to verify it.

## Glossary

These are the words that keep showing up once you read the code. The definitions below are intentionally plain-language, but they track the runtime types in `packages/workflow-graph/src/types.ts`.

- **Plan**: A YAML document describing a workflow: a name, defaults like `baseBranch` / `featureBranch`, and a list of tasks with ids, descriptions, and dependency edges. Plans are parsed into a `PlanDefinition` with validation on required fields.
- **Workflow**: The persisted instance created from a plan. It has durable identity, stored tasks, and workflow-level fields (including a generation counter used to salt branch naming and invalidate stale work).
- **Task (node)**: One unit of work in the DAG: a human-readable description, dependency ids, a `TaskConfig` (what to run and how), and `TaskExecution` (runtime fields like branch/commit/workspace metadata).
- **Task status**: The workflow-visible lifecycle label (`pending`, `running`, `failed`, `needs_input`, `review_ready`, `awaiting_approval`, `stale`, and others).
- **Attempt**: An immutable execution record for a task node: input snapshot metadata (including upstream attempt lineage), execution progress, and outputs like branch/commit when work finishes.
- **Selected attempt**: The attempt a task is currently treating as authoritative for downstream composition and staleness checks.
- **Executor**: The runtime that actually runs a task (`worktree`, `docker`, `ssh`, or the internal `merge` gate executor). The orchestration engine stays executor-agnostic in its core task model.
- **WorkRequest / WorkResponse**: The request/response shapes used when the engine dispatches work to an executor worker (Invoker’s protocol is documented alongside the type definitions).
- **Upstream branches**: Branches produced by completed dependencies (including external workflow dependencies) that downstream worktrees must merge or build on so upstream code changes are not silently dropped.
- **Merge gate**: A workflow-owned convergence point where branches are composed under explicit review/approval policy (modeled as a merge node in execution).
- **Surface**: A product integration boundary (desktop UI, headless CLI, Slack, and so on) that talks to the same core workflow actions rather than re-implementing orchestration ad hoc.
- **Command / mutation path**: The serialized path where workflow-affecting operations are applied in a single ordered stream (`CommandService`), instead of letting every caller mutate state however it wants.
- **Single-writer persistence**: A safety rule for SQLite-backed storage: only one owning process should write; other processes should delegate mutations through the owner so on-disk state cannot be accidentally overwritten by stale snapshots.

## End-to-end example (one happy path)

Mermaid source for the one-glance tour: [`docs/invoker-end-to-end-happy-path.mmd`](./invoker-end-to-end-happy-path.mmd).

This is a concrete “tour” of the same story the architecture docs tell, but in time order.

### 1) Author a plan as YAML

You write a small DAG: task `deps` installs or updates dependencies, task `tests` runs verification, and `tests` depends on `deps`.

```yaml
name: ci-hardening
baseBranch: main
tasks:
  - id: deps
    description: Refresh lockfile and install dependencies
    command: pnpm install --frozen-lockfile
  - id: tests
    description: Run unit tests
    command: pnpm test
    dependencies: [deps]
```

The plan parser validates the shape (non-empty tasks, required ids/descriptions) and applies defaults such as deriving a `featureBranch` when you omit it.

### 2) Turn the plan into a persisted workflow

When a surface loads the plan, Invoker materializes tasks in storage and records enough workflow metadata for later scheduling, dispatch, and invalidation. The orchestrator treats the database as the source of truth for what the workflow *means* right now.

### 3) Schedule runnable tasks under a concurrency cap

When dependencies are satisfied, work becomes runnable and is drained through a scheduler that enforces a global concurrency limit. That is the “Airflow-shaped” part of the runtime: a DAG plus a scheduler, but backed by Invoker’s own persistence and invalidation rules.

### 4) Dispatch an executor using an explicit worker protocol

For each runnable task, `TaskRunner` gathers upstream context and upstream branches, then builds a `WorkRequest` for the selected executor.

If a completed dependency is missing branch metadata, dispatch fails fast: without a branch, downstream work could run against the base branch and silently drop upstream implementation changes.

### 5) Run work in isolation and record outputs

Executors run in isolated workspaces (worktree, container, or SSH). As work progresses, you see familiar lifecycle states on the task, while attempts preserve an audit-friendly record of what ran.

### 6) Converge through a merge gate (and human approvals, when configured)

When the DAG reaches a merge gate, Invoker composes branches and applies review/approval policy as part of workflow progression rather than as an informal side channel.

### 7) Operate the same workflow from multiple surfaces

The same kinds of actions you would take in the UI (approve, reject, provide input, retry/rebase flows when wired up) are centralized as shared workflow actions on top of the orchestrator API, so headless and GUI paths do not drift.

## Bottom line

The cleanest description I know after reading the repo is this:

> Invoker is a persisted workflow engine that runs a DAG of work in isolated environments and composes the output through git branches, merge gates, and review policy.

That is why it feels part build system, part workflow orchestrator, part CI runner, and part code-review control plane.

And that is also why the coding style matters so much. Once you decide the system is about explicit state transitions, hidden state stops feeling convenient and starts feeling dangerous.

## Appendix: explicit mapping charts

This appendix is the more explicit version of the comparisons above. It is here for readers who want the direct “idea -> where it comes from -> how Invoker uses it” mapping without putting that density in the middle of the article.

### Bazel

| Idea | Where Bazel uses it | How Invoker adapts it |
|---|---|---|
| Request / response worker protocol | Bazel persistent workers receive a `WorkRequest` and return a `WorkResponse`. | Invoker uses the same shape for orchestrator-to-executor dispatch. |
| Deterministic identity | Bazel derives action identity from explicit inputs. | Invoker derives task branch names from task identity, execution inputs, upstream commits, plan base, and generation salt. |
| Staleness and invalidation | Bazel rebuilds when upstream inputs change. | Invoker marks downstream work stale when selected upstream attempts are no longer current. |
| Isolated execution | Bazel uses sandboxes and worker strategies to keep actions isolated. | Invoker runs tasks in worktrees, containers, or SSH workspaces instead of mutating shared state directly. |
| Action graph discipline | Bazel builds an action graph from declared dependencies. | Invoker uses a workflow DAG plus attempt lineage to decide what may run and what must be invalidated. |

### Airflow

| Idea | Where Airflow uses it | How Invoker adapts it |
|---|---|---|
| DAG as the organizing model | Airflow models pipelines as DAGs. | Invoker models workflows as DAGs whose edges affect readiness, scheduling, and invalidation. |
| Scheduler | Airflow runs tasks in dependency order under resource constraints. | Invoker uses a queue and concurrency cap to drain ready work. |
| Visible lifecycle states | Airflow exposes task states for operators. | Invoker exposes states like `pending`, `running`, `failed`, `needs_input`, `review_ready`, `awaiting_approval`, and `stale`. |
| Graph and timeline views | Airflow gives operators graph-oriented UI views. | Invoker uses graph and timeline views so operators can understand workflow progress visually. |
| Retry and rerun mental model | Airflow gives operators a structured model for rerunning work. | Invoker uses retries, recreation, and downstream invalidation to rerun work explicitly. |

### Temporal

| Idea | Where Temporal uses it | How Invoker adapts it |
|---|---|---|
| Durable workflow state | Temporal persists workflow state and history. | Invoker persists workflow and task state so execution can be resumed from saved state. |
| Multiple clients, one engine | Temporal separates workflow execution from the clients that talk to it. | Invoker lets the desktop UI, headless CLI, and Slack talk to the same core engine. |
| Human-in-the-loop interaction | Temporal supports Signals and message handling to affect running workflows. | Invoker uses explicit commands like approve, reject, provide input, and select experiment. |
| Dynamic workflow shape | Temporal supports child workflows and dynamic composition. | Invoker can mutate the graph at runtime through experiments, reconciliation, and replacement tasks. |
| Serialized workflow meaning | Temporal's message model emphasizes safe handling of concurrent workflow interactions. | Invoker serializes mutation handling through `CommandService` so workflow meaning stays ordered even when execution is concurrent. |

### CI/CD systems

| Idea | Where CI/CD systems use it | How Invoker adapts it |
|---|---|---|
| Branch-per-task isolation | CI systems often isolate work per branch or checkout. | Invoker gives tasks isolated workspaces and branch-based outputs. |
| Approval gates | CI/CD systems use protected environments and approvals before release steps. | Invoker makes merge and review approval part of workflow progression. |
| Runner types | CI systems offer different runners and execution environments. | Invoker supports local worktrees, Docker, and SSH executors. |
| Fan-out / fan-in | CI systems often run matrices in parallel and then converge. | Invoker supports experiment fan-out and later reconciliation or merge-gate convergence. |
| PR-centered completion | CI systems often end in status checks and pull requests. | Invoker treats PRs and review gates as part of workflow composition, not just side effects. |

### Git

| Idea | How it works in Invoker |
|---|---|
| Workspaces as sandboxes | Tasks run in isolated worktrees, containers, or SSH workspaces instead of directly in the host repo. |
| Branches as outputs | A task result is often represented by a branch that downstream work can consume. |
| Merge as composition | Workflow outputs are composed through merge or review gates rather than being treated as unrelated completions. |
| Conflicts as workflow events | Conflicts are surfaced as explicit workflow problems, not hidden cleanup work. |
| Git as substrate, not plumbing | Invoker uses git structure as part of the execution model itself, which is what makes it feel distinct from a normal task runner. |

## Where to read more

- [docs/architecture-overview.md](./architecture-overview.md) — runtime layers and comparisons
- [docs/persistence-architecture-single-writer.md](./persistence-architecture-single-writer.md) — single-writer SQLite rule
- [ARCHITECTURE.md](../ARCHITECTURE.md) — package layers and boundaries
- [CLAUDE.md](../CLAUDE.md) — contributor workflow and verification


---
