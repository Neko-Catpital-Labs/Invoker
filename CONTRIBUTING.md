# Contributing to Invoker

Thanks for your interest in Invoker. This guide is short on bureaucracy and long on the architectural commitments that any change has to respect — because the things that make Invoker useful (durability, auditability, predictable behavior) are the same things that make contributing to it different from contributing to a typical app.

If you've read [Part 2: Architecture](docs/invoker-medium-article.md), most of this will feel familiar. If you haven't, the short version is: **Invoker is a control system for software work**. Workflow state is explicit, durable, and reconstructable; code changes are part of the execution model, not incidental plumbing. Contributions should reinforce that, not erode it.

## Where to file issues and feature requests

The roadmap and issue tracker live at **[invoker.productlane.com/roadmap](https://invoker.productlane.com/roadmap)**. File bugs, feature requests, and roadmap feedback there. GitHub Issues is fine for code-level discussion tied to a specific PR or commit, but the productlane board is the source of truth for what we're working on next.

When you file an issue, the most useful things you can include are:

- The plan (or a minimal version of it) that reproduces the behavior.
- The workflow + task lifecycle states you observed, not just the symptoms.
- Whether the issue is about **a single execution**, **the persisted history of executions**, or **how surfaces (UI / CLI / Slack) reflect that history** — these are different layers and the fix usually lives in only one of them.

## Design principles every change has to respect

These aren't style preferences. They're the load-bearing assumptions of the system, and they're enforced by code review, the dependency-graph check, and tests.

### 1. Make state explicit

Persistence is the source of truth, not process memory. If a change introduces in-memory state that survives across operations and isn't reflected in the database, that's a defect waiting to happen — even if the current code path "works." Prefer reconstructing state from the persisted record over caching it.

### 2. Keep mutation paths narrow

Anything that changes workflow meaning goes through the single serialized control plane. Don't add a side door for "just this one case." Concurrent control actions stay safe because there is exactly one ordered stream of mutations per workflow; a second pathway breaks that guarantee silently.

### 3. Keep graph logic pure

The workflow graph is pure DAG logic — readiness, traversal, invalidation. It does not know about executors, branches, sockets, or the filesystem. If you find yourself reaching for I/O from inside graph code, that's a sign the boundary is in the wrong place.

### 4. Respect hard package boundaries

The repo enforces layered dependencies with no cycles and no upward leaks across layers. Lower layers (graph, contracts) cannot import from higher layers (engine, app, surfaces). Run `pnpm run check:all` before sending a PR — if the dependency-graph check fails, the change isn't ready, regardless of how it behaves at runtime. See [ARCHITECTURE.md](ARCHITECTURE.md) for the layer rules.

### 5. Prefer official control paths over shortcuts

For anything that touches the workflow database, use the headless commands (`pnpm exec electron dist/main.js --headless ...`) rather than poking SQLite directly. The headless surface goes through the same control plane as the desktop app, which is precisely why it's safe; a raw SQLite write is precisely why it isn't. The same rule applies to scripts, tests, and one-off debugging.

### 6. Make verification executable

"I tested it mentally" is not a verification. PRs should describe what was actually run — `pnpm test`, `pnpm run check:all`, a specific headless command, a reproduced workflow — not what was reasoned about. If a behavior can't be exercised by a command, that's usually a sign the boundary it lives behind is too informal.

## What "code change" means here

Because Invoker treats code changes as the output of a workflow, contributions to Invoker are themselves a small example of what Invoker orchestrates. A few practical implications:

- **Branch per change.** One conceptual change per branch and per PR. Mixed-concern PRs are hard to review and harder to invalidate cleanly if one part has to be reverted.
- **Treat review as a workflow state, not a formality.** If reviewers ask for something, it's because the merge gate — the human one and the automated one — exists for a reason. Don't bypass it with force-pushes after approval.
- **Conflicts are events, not chores.** If your branch conflicts with `master`, that's signal about overlapping work, not just a rebase task. Look at what changed upstream before resolving mechanically.
- **Determinism over cleverness.** Given the same inputs, behavior should be the same. Hidden state — env vars read at runtime, wall-clock dependence, ordering assumptions — turns into Heisenbugs very quickly in a system that persists and replays its history.

## Pull request checklist

Before requesting review, please confirm:

- [ ] The change respects the layer rules in [ARCHITECTURE.md](ARCHITECTURE.md) (`pnpm run check:all` passes).
- [ ] Tests pass (`pnpm test`, or `pnpm run test:all` for broader coverage).
- [ ] Any new mutation goes through the existing command path; no direct DB writes from new code paths.
- [ ] Any new persisted field is reflected in types under `packages/workflow-graph/src/types.ts` and `packages/contracts/`.
- [ ] The PR description names the verification commands you actually ran.
- [ ] User-visible behavior changes are documented (in the README, in `docs/`, or in the relevant package README — wherever the existing description lives).

## Development setup

See the **Installation** and **Development** sections of the [README](README.md). The short version:

```bash
pnpm install
bash scripts/setup-agent-skills.sh
pnpm run build
pnpm test
```

Repo conventions for agents and contributors: [CLAUDE.md](CLAUDE.md). Persistence rules (especially around the single-writer constraint): [docs/persistence-architecture-single-writer.md](docs/persistence-architecture-single-writer.md).

## Licensing of contributions

Invoker is released under the [Functional Source License, Version 1.1, ALv2 Future License](LICENSE) with an addendum from Neko Catpital Ventures, LLC. By submitting a contribution, you agree that it is licensed under the same terms.
