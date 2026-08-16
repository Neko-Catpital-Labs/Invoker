# Invoker Project Instructions

## Planning Rules

### Slash commands and agent skills

- **Precedence:** When a Cursor slash command or an **attached skill** says to follow a skill (e.g. `/plan-to-invoker`), that workflow **overrides** a bare “implement this” sentence in the same message. Complete the skill steps (including `bash skills/plan-to-invoker/scripts/skill-doctor.sh <plan-file>` and user confirmation) before editing product code for that request.
- **Bootstrap after clone:** Run `bash scripts/setup-agent-skills.sh` to build the CLI/app artifacts and install bundled `invoker-*` skills into Codex, Claude, and Cursor. Optional: `bash scripts/test-plan-to-invoker-skill.sh` when changing skill layout.
- **Repo rule:** See `.cursor/rules/skill-command-precedence.mdc` for the always-on summary.
- **Vendored skills:** `skills/reflect/` is vendored from the separate `catstack` skills repo (canonical source), copied in because `ci-regression-watch`'s headless remote CI-repair tasks read `skills/reflect/SKILL.md` straight out of this repo with no catstack clone available on the SSH pool worker. Never hand-edit `skills/reflect/` directly — edit `catstack`'s copy, commit it there, then run `bash scripts/vendor-reflect-skill.sh --source <path-to-catstack-checkout>` to re-sync. `skills/reflect/.vendor-source.json` records the source commit; check it against `catstack`'s current HEAD if you suspect drift.
- **Benchmark direct output:** If a `/plan-to-invoker` request says `For this benchmark`, `Required output path:`, `Write the final YAML plan to`, or `Do not submit the plan`, write a complete command-only YAML plan directly to the literal required path. The first top-level keys must be `name:`, `onFinish:`, `mergeMode:`, `repoUrl:`, and `tasks:`. Do not write `version:` or `metadata:` wrappers. Do not run `git remote`, `env`, `printenv`, `set`, schema scans, validation loops, submit commands, prompt tasks, nested `steps:`, or anything that can trigger an agent/autofix. If no repo URL is provided, use `https://github.com/Neko-Catpital-Labs/Invoker.git`.

- Implementation plans must include a user-confirmed `Safety invariant:` for every slice; follow `skills/review-compression/SKILL.md` and ask before finalizing.
- Every step in a plan MUST be testable. Each implementation step must have a corresponding verification with a concrete, executable command that produces a clear pass/fail exit code (e.g. `pnpm test`, `git diff --name-only`). Do not use AI prompts for test tasks — use commands only.
- Bug fix plans MUST follow a three-phase approach before any implementation:
  1. **Reproduce** -- Find or write a concrete reproduction case (a failing test or a command that demonstrates the bug). Report back the exact repro steps and observed vs. expected behavior. Do not proceed until the bug is reliably reproducible.
  2. **Debug and report** -- Investigate and report: (a) the root cause — why the code is in the buggy state, and (b) the test gap — how the bug escaped existing tests (missing coverage, wrong assumptions, untested edge case, etc.). For a UI or runtime behavior bug, instrument or trace the actual failing behavior first (logging, a MutationObserver, a debugger, a targeted repro) before proposing a fix hypothesis. Do not propose a root cause by pattern-matching to a bug that looks similar; a hypothesis that was not directly observed is a guess and must be stated as one until it is. A fix-ci task's own "first observed failing at `<SHA>`" is a chronological anchor for when the failure became visible, not a claim that `<SHA>`'s diff caused it — for infra-class jobs (system-dependency provisioning, flaky self-hosted runners) the anchor commit is frequently unrelated (e.g. `cd07355fe0` was a 47-line deletion from `run.sh`'s production-DB guard with no connection to the `unzip`/apt-get fix a `required-fast-extra` job repair actually needed); investigate the runner/environment and the currently-failing local repro directly instead of the anchor commit's diff. If the failure signature matches an existing `scripts/repro/repro-*.sh` script by name or symptom, run `git log --oneline --all --grep=<the symptom, e.g. "unreachable commit"|"invalid reference"|"safe-push"> -i` before finalizing the root cause — a prior fix in this area may have addressed only one narrower cause of a recurring architectural hazard, not the whole class (e.g. #6836 fixed a wrong-ref-selected-for-push bug in `pushBranchToRemote`; a structurally similar but distinct fetch-race bug in the same "downstream task can't resolve a dependency's commit" symptom family recurred four times across 2026-04-07 through 2026-08-15 before anyone generalized the fix). The same class-search applies to CI native/system-dependency provisioning failures (`apt-get install` / `node-gyp` errors in `.github/workflows/ci.yml`): before adding the one missing package the error names, run `git log --oneline --all -S "apt-get install" -- .github/workflows/ci.yml` to check whether that job's install step has already been patched this way — e.g. UI Vitest's "Install Node runtime system dependencies" step gained `libatomic1, make, g++, python3` (ec4a30c54), a `sudo -n` capability check (daaa3bdaf), and `unzip` (876f8bda1), three one-tool-at-a-time patches to the same step within five hours. `.github/workflows/ci.yml` has 10+ separate `apt-get install` lines across its jobs, each with its own independently drifted package list (some missing `libatomic1`, some missing `unzip`) instead of one shared, complete list — so the same missing-tool failure keeps recurring in a different job even after another job's copy gets patched. The plain `-S "apt-get install"` search is noisy (78+ hits, mostly boilerplate task-spec trailers unrelated to the actual code change) — also run `-S` on the specific failing invocation or tool name (e.g. `-S "sudo -n true"`, `-S "has_libatomic"`) to get a tighter hit list. If that search turns up 3+ prior independent commits patching the same missing-native-tool failure class (in this job's own step or another job's), the task's summary must include a `Consolidation signal:` block naming the count and the prior commit hashes and recommending — not performing — a follow-up to extract one shared composite action/script; a job-scoped bug-fix slice should still land its own fix, but silently adding yet another one-off copy of a hazard already flagged this many times is a bigger, more accountable miss than the transcript alone would show. (e.g. `99621afc1` reused the known `has_libatomic`/`sudo -n` pattern for `required-fast-extra`'s own "Install system libraries for Node" step, but that same step had already been independently patched at least 3 prior times going back to `d269de2f5` — on top of the separate 3-patches-in-five-hours UI Vitest history above — and the fix's task summary made no mention of that recurrence.) The class-search can also turn up a root-cause fix to the *product/script file itself* (not just `.github/workflows/ci.yml`) that already exists but was never merged: `scripts/electron.cjs`'s system-`unzip` dependency was independently rewritten to use the bundled `extract-zip` package at least five times (commits `6a91078e7`, `001aa2c47`, `f3852d999`, `8fef0928e`, `69259a9af`) across separate CI-repair workflows for three different job IDs, because each fix landed on its own disposable branch that was never merged to master — and PR #9319 merged only the prerequisite repro script for this fix, not the repair itself, leaving the pairing incomplete. If `git log --all -S <token>` / `--grep` finds an identical fix already authored on a branch that `git merge-base --is-ancestor <that commit> HEAD` reports is NOT an ancestor, that is a landing-process gap, not just a reuse opportunity: check `gh pr list --search <file>` for an open or merged-but-partial PR stack touching that file before re-authoring on yet another disposable branch, and say so explicitly in the task summary so the non-landing doesn't go unnoticed a sixth time. The same class-search applies to a reusable code *anti-pattern*, not just a previously-fixed symptom: before closing a bug-fix task whose root cause is a generic pattern rather than a one-off, grep the codebase for other live instances of that exact pattern and report how many remain unfixed — e.g. a Playwright `page.waitForFunction(predicate)` whose predicate body calls `.then(` returns a Promise object, which is always truthy, so the retry loop fulfills on the first tick instead of actually polling; PR #9267 ("Fix loadPlan and expectWorkflowStatus timing races") fixed this in a shared `loadPlan()` helper, but `dag-click-hitch-responsiveness.spec.ts`'s own inline duplicate was missed by that fix and by a later hardening pass on the same file, and two more live instances (`visual-proof.spec.ts:2724`, `embedded-terminal-restart-persistence.spec.ts:99`) were still unfixed as of 2026-08-16 — three separate sessions each patched one instance instead of generalizing. This recurred again in `required-fast / Merge Gate Concurrency Repro` (first failing at 59df38dfc): two independent fix attempts on the same step each covered only half of the ui-vitest precedent — one (`5985a2df3`) matched the *package-list* half (`libatomic1 make g++ python3 unzip`) but ran it as a raw, unguarded `sudo apt-get install`, the exact anti-pattern `daaa3bdaf` replaced for ui-vitest; a sibling attempt (`b87cf9104`) independently fixed only the *sudo-guard* half without the full package list. Neither alone was the complete fix — landing required manually combining both halves (done in the same pass that resolved this pair's rebase conflict). Treat "the guarded pattern" as both halves together; a `git log -S` hit that only shows a package-list diff for the precedent does not prove the guard was replicated too, and vice versa. Two things let this gap ship unnoticed: first, `scripts/test-ci-workflow-merge-queue-policy.mjs` asserts the full package list *and* the sudo-guard for `ui-vitest`'s install step, but for `required-fast-extra`'s install step (the one this fix touched) it only asserts 3 of the 5 needed tokens (`libatomic1`, `make`, `g++` — not `python3`, `unzip`, or the guard) — when you touch a job's install step, extend that script's assertion for it to match the ui-vitest rigor, so an incomplete copy fails the policy check instead of shipping; this assertion gap is still open as of this landing. Second, this class of fix cannot be proven by the standard `pnpm build && ... test` repro chain: the agent's own sandbox already has a working toolchain and root, so that chain passes whether the CI-only provisioning fix is complete, incomplete, or a no-op (here, `scripts/test-suites/required/17-merge-gate-concurrency-repro.sh` is a pure in-memory Vitest unit test that never touches apt-get, sudo, or Node runtime libraries). For a `.github/workflows/ci.yml`-only provisioning fix, the real verification is a static assertion against the workflow YAML (`node scripts/test-ci-workflow-merge-queue-policy.mjs`), not the product build/test command — and since these install steps are usually shared across a job's whole matrix, name any other matrix entries that share the step you changed in the task summary, since a fix proven against one named job's local repro says nothing about its siblings. This class-search is not specific to `apt-get install`: before landing a fix scoped to one job's copy of a named step, run `grep -c "<step name>" .github/workflows/ci.yml .github/workflows/pr-body.yml` to see how many other copies of that step exist, and if the fix isn't applied to all of them, say so explicitly in the task summary rather than letting the fix look complete — e.g. `.github/workflows/ci.yml`'s "Reclaim workspace" step (7 copies as of this writing) was independently patched by three separate commits for three different jobs (`948444816`, `ce60c38a3`, `47cb28ca4`) before a fourth commit added a `find "$GITHUB_WORKSPACE/.git" -name '*.lock' -delete` cleanup to only the `ui-vitest` job's copy, leaving the other 6 copies exposed to the same stale-lock failure mode on the next reused self-hosted runner.
  3. **Plan the fix** -- Only after completing steps 1 and 2, create the implementation plan. The plan must include a verification step that re-runs the reproduction case to confirm the fix.
- When a request names "the X task(s)" or "the X workflow(s)" ambiguously, check both the repo (grep for a generator/template) and live Invoker state (`query workflows`/`query tasks`) before scoping the change. If more than one distinct system matches the name, say so and ask which one(s) are in scope rather than picking the first match found in code (e.g. a repo-side plan generator and a separate family of one-off, ad hoc submitted workflows can share the same descriptive name but have no code relationship at all).
- When adding a substring/signature-based crash or failure detector over a cumulative log, the test suite must include a case where the signature appears earlier in the log but the underlying task's final status is success — not just "signature present" / "signature absent." A partial-log match is never sufficient proof of a terminal state on its own (e.g. `repair_task_crashed_on_infra` in `scripts/mergify_admin_requeue_infra_signal.py` reported a repair as crashed because an OAuth-expired error appeared 4 times in its log from early self-healing retries, even though the task ultimately completed — fixed in PR #9312).

## Landing PR Stacks

- When asked to **land / merge / ship / queue** a PR or PR stack, follow `skills/land-stack/SKILL.md`.
- Never choose a PR by branch-name lookup (`gh pr list --head <branch>`). Two PRs can share a branch name (a raw workflow branch PR vs the intended `stack/...` PR). If PR numbers are missing, broadly list open PRs, filter to `stack/` heads, verify local head SHAs, order by base/head links, and suggest bottom-up numbers for confirmation. Land by confirmed PR number only.
- Verify before any write: `node scripts/land-stack.mjs <pr> [<pr> ...]` must exit 0 (checks head SHA is in the local clone, head branch is a real `stack/` branch, the PRs form a proper stack, all OPEN). Land via `node scripts/land-stack.mjs <pr> ... --execute`. Do not hand-add `admin-bypass` or `gh pr merge` to bypass the guard.
- See `.cursor/rules/land-stack-precedence.mdc` for the always-on summary.

## SQLite Command Policy

- If you are considering direct SQLite commands, use the corresponding Invoker headless command first.
- For normal local operations on workflows or tasks, prefer `./run.sh --headless ...` and `node scripts/headless-ipc.js ...` over SQLite reads or writes. Typical examples: `query workflows`, `query tasks`, `retry`, `retry-task`, `rebase-recreate`, `approve`, `reject`, `cancel`, and `cancel-workflow`.
- Verify operational changes with Invoker query commands (`query workflows`, `query tasks`, `query queue`, `query audit`) instead of SQLite inspection whenever the command surface exists.
- If no corresponding headless command exists, stop and prompt the user with a concrete plan to add that headless command functionality before proceeding.

## Testing Architecture

All packages use standard `vitest run` via `pnpm test`. The persistence layer uses `sql.js` (WASM-based SQLite), so tests run under system Node with no native SQLite addon or Electron test runtime.

### How it works

- Every package's `package.json` has `"test": "vitest run"`.
- Root `pnpm test` runs packages **one at a time** (`pnpm -r --workspace-concurrency=1`) so constrained machines stay responsive; `pnpm run test:high-resource` uses parallel package runs.
- `pnpm --filter @invoker/ui test` and full `pnpm test` runs reliably exceed the Bash tool's default 2-minute timeout. Launch them with `run_in_background: true` (or an explicit longer `timeout`) from the start rather than running in the foreground and retrying after a timeout kill. To wait on the background run, use a `Monitor` until-loop against the redirected log file — not `ScheduleWakeup`, which requires a `prompt` field and errors (`` `prompt` is required when `stop` is not true ``) if called with only `stop`/`noop` for a simple wait.

### In plan tasks

**ALWAYS use `pnpm test` in plan task commands, NEVER use `npx vitest run` or direct vitest calls.**

```yaml
# Wrong — vitest may not be in PATH:
command: "cd packages/surfaces && npx vitest run"
command: "cd packages/surfaces && vitest run"

# Right — uses package.json test script:
command: "cd packages/surfaces && pnpm test"
```

### Worktree provisioning

`WorktreeExecutor` does not run any dependency install by default (see `default-worktree-provision-command.ts`). A pool's `worktreeTargets` config can opt a local target back in with an explicit `provisionCommand` such as `pnpm install --frozen-lockfile`; this repo's own local dev config does this for `local-mac`/`local-fallback`. That command applies to every `repoUrl` routed through the pool, so a workflow targeting a non-Node repo needs its own entry in the top-level `repoProvisionCommands` config (keyed by `repoUrl`, empty string for "no install step") to avoid a hard provisioning failure — see `packages/execution-engine/src/base-executor.ts`.

Verify worktree provisioning end-to-end:

```bash
bash scripts/test-worktree-provisioning.sh
```

### Long-running Playwright/e2e commands

Full-suite Playwright/e2e runs (e.g. `scripts/test-suites/optional/40-playwright-app.sh`) routinely take longer than a synchronous shell call's timeout. Start them with `run_in_background: true` from the first attempt and poll with `Monitor`'s until-loop — do not run them synchronously and only background them after they time out. This exact anti-pattern (a synchronous run hitting a timeout, followed by a blocked `sleep N; tail <file>` retry) recurred independently in two separate CI-fix sessions for the same job on 2026-08-16.

### Executor tests and git safety

Tests that create real `WorktreeExecutor`/`DockerExecutor` and call `.start()` run real git via `BaseExecutor.execGitSimple()`. To prevent repo mutation:

1. **Mock git lifecycle** (for tests that don't need real git): spy on `execGitSimple`, `syncFromRemote`, `setupTaskBranch`, `recordTaskResult`, `restoreBranch`, `pushBranchToRemote`. See spies in `open-terminal.test.ts` or integration tests that mock `BaseExecutor.prototype.execGitSimple`.
2. **Use a sandbox repo** (for tests that validate git behavior): `mkdtempSync` + `git init`. See `auto-commit.test.ts`, `branch-chain.test.ts`.

## File Editing Discipline

After making a change with any edit tool, **read the file back from disk** (using the Read tool or `rg` in the Shell) and verify the edit persisted before proceeding. Cursor's in-memory state can silently revert writes. If the change is missing on disk, re-apply it using the Shell tool (e.g. `python3 -c "..."` or `sed`) and verify again. When committing, always `git diff --stat` immediately before `git add` to confirm the working tree contains the expected modifications.

## Comment Policy

Do not add explanatory comments to product code by default.

Prefer clearer names, smaller functions, or simpler control flow.

Allowed comments only:

- legal or license headers
- generated-code markers
- `eslint`, `ts-expect-error`, `ts-ignore`, `shellcheck`, or tool directives
- non-obvious safety invariants where removing the comment would make the code risky
- public API docs when that area already uses them

Before finishing a PR, remove any comment you added unless it matches one of the allowed cases.

## Code Navigation

Use LSP tools (`goToDefinition`, `findReferences`, `documentSymbol`, `workspaceSymbol`, `incomingCalls`, `outgoingCalls`, `hover`) for any task involving symbols, types, or cross-file relationships. Use Grep and Glob for literal text searches and file discovery.
