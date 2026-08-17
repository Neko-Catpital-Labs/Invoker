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
  2. **Debug and report** -- Investigate and report: (a) the root cause — why the code is in the buggy state, and (b) the test gap — how the bug escaped existing tests (missing coverage, wrong assumptions, untested edge case, etc.). For a UI or runtime behavior bug, instrument or trace the actual failing behavior first (logging, a MutationObserver, a debugger, a targeted repro) before proposing a fix hypothesis. Do not propose a root cause by pattern-matching to a bug that looks similar; a hypothesis that was not directly observed is a guess and must be stated as one until it is. A fix-ci task's own "first observed failing at `<SHA>`" is a chronological anchor for when the failure became visible, not a claim that `<SHA>`'s diff caused it — for infra-class jobs (system-dependency provisioning, flaky self-hosted runners) investigate the runner/environment and the currently-failing local repro directly instead of the anchor commit's diff.

     **Class-search, before finalizing any root cause:** run `git log --oneline --all --grep=<symptom>` for a matching prior fix, and `git log --all -S <token>` for a matching diff — use a narrow token (a tool name, a flag, a specific pattern like `sudo -n true`) rather than a broad one like `apt-get install` (78+ noise hits, mostly boilerplate). This covers three kinds of drift, not just missing packages: a missing package in an install step, a missing safety/capability-check pattern (e.g. a `sudo -n` guard applied to one job but not a sibling job's copy of the same step), or a reusable code anti-pattern duplicated across files. Check every sibling: `grep -c "<step name>" .github/workflows/*.yml` shows how many copies of a CI step exist; grep the codebase for other live instances of a code pattern. Report in the task summary how many your fix does and doesn't cover — a fix proven against one named job or one instance says nothing about its siblings. Also check `gh pr list --search <file>` for an already-authored but never-landed fix on a disposable branch before re-authoring one. If the search turns up 3+ prior independent commits already patching this exact failure class, add a `Consolidation signal:` block naming the count and commit hashes and recommending (not performing) a follow-up to extract one shared fix — still land your own job-scoped fix, but say so. For a `.github/workflows/ci.yml`-only provisioning fix, prove it with a static assertion against the workflow YAML (e.g. `node scripts/test-ci-workflow-merge-queue-policy.mjs`), not the product build/test chain — that chain passes in the agent's own sandbox regardless of whether the CI-only fix is complete. See "Class-search precedents" below for the incidents that motivate each part of this rule.
  3. **Plan the fix** -- Only after completing steps 1 and 2, create the implementation plan. The plan must include a verification step that re-runs the reproduction case to confirm the fix.
- When a request names "the X task(s)" or "the X workflow(s)" ambiguously, check both the repo (grep for a generator/template) and live Invoker state (`query workflows`/`query tasks`) before scoping the change. If more than one distinct system matches the name, say so and ask which one(s) are in scope rather than picking the first match found in code (e.g. a repo-side plan generator and a separate family of one-off, ad hoc submitted workflows can share the same descriptive name but have no code relationship at all).
- When adding a substring/signature-based crash or failure detector over a cumulative log, the test suite must include a case where the signature appears earlier in the log but the underlying task's final status is success — not just "signature present" / "signature absent." A partial-log match is never sufficient proof of a terminal state on its own (e.g. `repair_task_crashed_on_infra` in `scripts/mergify_admin_requeue_infra_signal.py` reported a repair as crashed because an OAuth-expired error appeared 4 times in its log from early self-healing retries, even though the task ultimately completed — fixed in PR #9312).
- When two independent functions each classify the same kind of input into parallel or overlapping category sets, adding a new rule to one without the other is a drift risk that can go undetected for months — e.g. `review-unit-rules.mjs`'s `classifyReviewUnitsForPath` classified `.github/` paths as `tooling-policy` (commit `1bf9744d58`, #1600), but `validate-pr-body.mjs`'s separate `classifyScopeKind` had no matching rule and silently dropped them, undetected for ~2 months until it broke the repair-normalize auto-split gate (fixed in #9403). When adding a new category rule to one classifier, grep for its sibling classifier(s) over the same kind of input and add matching coverage, or add a cross-check test asserting they agree.

### Class-search precedents

Concrete incidents that motivate the class-search rule above — each is a case where the same failure class recurred because an earlier fix wasn't checked for or generalized. Add new precedents here as their own bullet; do not append to the rule text above.

- **Anchor commit ≠ root cause**: `cd07355fe0` (a 47-line deletion from `run.sh`'s production-DB guard) was the "first observed failing at" anchor for a `required-fast-extra` job repair that actually needed an `unzip`/apt-get fix unrelated to that diff.
- **Fetch-race recurrence**: #6836 fixed a wrong-ref-selected-for-push bug in `pushBranchToRemote`; a structurally similar but distinct fetch-race bug in the same "downstream task can't resolve a dependency's commit" symptom family recurred four times across 2026-04-07 through 2026-08-15 before anyone generalized the fix.
- **UI Vitest package-list drift**: gained `libatomic1, make, g++, python3` (`ec4a30c54`), a `sudo -n` capability check (`daaa3bdaf`), and `unzip` (`876f8bda1`) as three one-tool-at-a-time patches to the same step within five hours. `.github/workflows/ci.yml` has 10+ separate `apt-get install` lines across its jobs, each with its own independently drifted package list.
- **required-fast-extra install step, patched but still drifting**: `99621afc1` reused the known `has_libatomic`/`sudo -n` pattern for this step, but it had already been independently patched at least 3 prior times going back to `d269de2f5`, and the fix's task summary made no mention of that recurrence.
- **electron.cjs unzip rewrite, never landed**: `scripts/electron.cjs`'s system-`unzip` dependency was independently rewritten to use the bundled `extract-zip` package at least five times (`6a91078e7`, `001aa2c47`, `f3852d999`, `8fef0928e`, `69259a9af`) across separate CI-repair workflows for three different job IDs, because each fix landed on its own disposable branch that was never merged to master — PR #9319 merged only the prerequisite repro script, not the repair itself.
- **electron.cjs unzip rewrite, direction reversed after landing**: the precedent above was about the extract-zip rewrite never landing; that direction has since landed for real and was hardened further (`ff88543e4`/#9406, plus #9384; #9430 didn't even touch the file, it only recommended closing a now-superseded verification plan since master already had zero `unzip` references). Despite that merged, reviewed state, six more independent commits (`46c3d8678`, `f287cb535`, `8aac2e60c`, `0e167f82b`, `eb7a5d7dc`, `19ba50ada`) within a ~2-hour window on 2026-08-17 re-added a *preferred* system-`unzip` path on top of a parent commit that already had zero `unzip` references — an active reversal of merged work, not just a duplicate no-op. Three of the six independently wrote near-identical, uncited justification comments ("yauzl-based extraction can silently stop/hang after the first entry on some self-hosted CI filesystems/Node builds") with zero corroborating incident, log, or PR anywhere in this repo's history (`git log --all -S "openReadStream"`, `--grep=yauzl -i`, and `gh pr list --search yauzl` all return nothing outside these six commits). Near-verbatim unverified technical claims about third-party library internals, recurring across sessions that never saw each other's output, is a signature of plausible-sounding confabulation, not corroboration — matching wording across independent sessions is a reason to go find the actual log line, not a reason to trust the shared narrative. Before touching this file's extraction path specifically, check `git log -- scripts/electron.cjs` (does the file you're about to edit already show zero references to what you're about to reintroduce?) and `gh pr list --search electron.cjs --state merged`; a diff that reverses an already-merged, already-reviewed direction needs an explicit citation of the PR it contradicts, not just the absence of a duplicate *closed* PR to re-author.
- **skills/reflect/ vendoring discipline itself drifting**: the vendored-skills rule above exists specifically to keep this repo's `skills/reflect/SKILL.md` and `catstack`'s canonical copy from silently diverging — and, checked directly while drafting the precedent above, they have anyway, in both directions. `catstack`'s current copy has a "prefer categorical elimination over a skill line" review-routing framework this repo's copy lacks; this repo's copy has a "Degraded mode: no transcript survives" section and expanded Cost/History lens instructions that were never present anywhere in `catstack`'s own commit history (`git log --all -S` for that text in a fresh `catstack` clone returns zero hits). A legitimate vendor sync that would have reconciled some of this, `c49299d2a` (pulling `catstack@532a3298f`), was itself never merged to master, and `skills/reflect/.vendor-source.json` still records the older `bbafc7c` commit it pointed at before that attempt — the tracking file no longer matches either copy's actual content. Flagging for a human decision on how to reconcile (which side's unique content to keep, whether to re-run the vendor script and manually port over what it would otherwise drop); not attempted as part of this precedent bullet since guessing a merge order risks silently losing content from either side.
- **Playwright Promise-truthiness anti-pattern**: a `page.waitForFunction(predicate)` whose predicate body calls `.then(` returns a Promise object, which is always truthy, so the retry loop fulfills on the first tick instead of actually polling. PR #9267 fixed this in a shared `loadPlan()` helper, but `dag-click-hitch-responsiveness.spec.ts`'s own inline duplicate was missed by that fix and a later hardening pass, and two more live instances (`visual-proof.spec.ts:2724`, `embedded-terminal-restart-persistence.spec.ts:99`) were still unfixed as of 2026-08-16 — three separate sessions each patched one instance instead of generalizing.
- **Half-applied guarded pattern**: `required-fast / Merge Gate Concurrency Repro` (first failing at `59df38dfc`) had two independent fix attempts, each covering only half of the ui-vitest `sudo -n` precedent — `5985a2df3` matched the package-list half but ran it as a raw, unguarded `sudo apt-get install`; `b87cf9104` independently fixed only the sudo-guard half without the full package list. `scripts/test-ci-workflow-merge-queue-policy.mjs` only asserted 3 of the 5 needed tokens for this step, letting the incomplete copy pass. This class of fix can't be proven by the product `pnpm build && test` chain — the agent's own sandbox already has a working toolchain and root, so that chain passes whether the CI-only fix is complete, incomplete, or a no-op.
- **required-fast-extra's own sudo bootstrap, never patched at all**: unlike ui-vitest (`daaa3bdaf`) and the docker/cd07355 job (#9352), `required-fast-extra`'s "Install system libraries for Node" step ran a fully raw, unguarded `sudo apt-get` with no capability check whatsoever until it blocked a real merge-queue run with "a password is required" and was finally patched by #9436 (2026-08-16) — the third time this exact `sudo -n` pattern needed porting to a sibling job. A safety/capability-check pattern, not a package list, showing the class-search rule applies beyond missing packages.
- **Reclaim workspace, 7 copies**: `.github/workflows/ci.yml`'s "Reclaim workspace" step was independently patched by three separate commits for three different jobs (`948444816`, `ce60c38a3`, `47cb28ca4`) before a fourth commit added a stale-`.git`-lock cleanup to only the `ui-vitest` job's copy, leaving the other 6 copies exposed to the same failure mode.

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
