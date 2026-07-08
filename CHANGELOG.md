# Changelog

All notable changes to Invoker will be documented in this file.

## Unreleased

- Let the Worker tab scroll through all its Worker Processes. The Worker surface renders its canvas inside a plain block wrapper, but the canvas sizes its own height with `flex-1`, which is inert outside a flex container — so the canvas grew to its full content height and the Worker Processes / Worker Actions panes never received a bounded height to scroll within. The wrapper is now `flex flex-col` (matching the home surface), so the canvas is height-bounded and both panes scroll independently.
- Replace the failed-only fix entry guard with an explicit fix-session mechanism: `beginFixSession` accepts the resting states `failed`, `review_ready`, and `awaiting_approval`, records the entry status on the task, and `revertFixSession` restores exactly that status on every exit — agent failure, reject, or invalid workspace. Review-gate CI auto-fixes now actually execute instead of dying on dispatch, a failing or rejected gate fix returns the gate to review polling instead of marking an open gate failed, and starting a second fix while one is parked awaiting approval is refused. The ci-failure worker also folds terminal fix-intent outcomes back into its dedupe action, so a failed intent no longer leaves a repair showing "queued" forever and the worker retries within its attempt budget.
- Collapse the Test Plan and Revert Plan sections in GitHub PR bodies. Both sections keep their headings but their content now sits inside a collapsed `<details>` block. The PR body template, the make-pr skill, the deterministic fallback body, and `validate-pr-body.mjs` all enforce the new shape.
- Hold merge PRs that Invoker opens against its own repo to the full review-stack PR body before publication. When no agent can author a compliant body, PR creation fails loudly instead of shipping a fallback body that the PR Body CI check rejects.
- Remove a deleted workflow from the UI in under half a second: the renderer applies task removal deltas immediately instead of waiting out the 100ms graph event batch window (measured ~43ms end-to-end, down from ~140ms).
- Remove a deleted workflow from the UI within one second instead of leaving a ghost "pending" node until manual refresh. Task removal deltas now carry an in-stream `removed` rollup patch when a workflow's last task is removed, the renderer drops the workflow entry instead of resurrecting it, and a `workflow_removed_applied` UI perf metric records the propagation for regression tracking.
- Restore Planning Terminal chats after desktop restart, including visible transcripts and draft-ready state.
- Persist embedded terminal tabs across desktop app restarts, restoring their recent output and reopening spawn-backed sessions.
- Move auto-fix attempt counts out of SQLite task state and into in-memory worker runtime policy.
- Add a local master-head full-test repair cron that runs the destructive suite, asks OMP/Codex to fix confirmed failures, reruns the suite, and opens one validated PR per broken upstream SHA.
- Make the browser UI load heavy Action Graph data only when that tab opens, trim huge diagnostic strings, gzip large `/invoke` JSON responses, and stop checking PR statuses on initial page load.
- Move the Slack bot out of the Invoker app into its own always-on `@invoker/slack-manager` daemon. Previously the bot ran inside Invoker, so when Invoker died the bot died with it and no one could ask it to bring Invoker back. The manager now owns the Slack connection, keeps its planning sessions and per-workflow channel map in its own database, and drives Invoker over IPC (`headless.query`/`exec`/`run`). It watches Invoker's health and relaunches the GUI when it goes down, and a new `@Invoker restart` verb (Approve to confirm) brings it back on demand; a backoff guard prevents restart storms. Invoker itself now launches with Slack disabled — the manager is the sole Slack surface, supervised independently via a systemd user unit (cron keepalive fallback).
- Add Slack-native coding workflows: plan from a lobby `@Invoker` mention against a checked-out repo with a selectable planning harness (`[preset]`/`[repo:]` tags), spin the plan up as a workflow in a private `workflow-<id>` channel, and drive or question that workflow in-channel using only its own planning conversation and task transcripts.
- Watch a workflow's progress from two new surfaces beyond the desktop app. A browser surface serves the same UI over HTTP+SSE (enable with `INVOKER_WEB_TOKEN`, open `http://<host>:4200/?token=…`; set `INVOKER_WEB_HOST=0.0.0.0` to reach a remote/headless host), fully interactive via the existing mutation facade. Slack now shows one live status card per mapped `workflow-<id>` channel — a single message edited in place with per-task rows, counts, percent complete, and the PR/review link.
- Key the single-instance worker lock by worker kind, so different worker kinds can run at once while a second start of an already-running kind is still refused across both worker doors. The worker kind is validated before it becomes the lock filename, so it cannot escape the locks directory.
- Cap the `activity_log` table to its most recent 100000 rows, pruned as new entries are written, so `~/.invoker/invoker.db` can no longer grow without bound and trigger SIGBUS crashes.
- Add `invoker-cli doctor` (config-aware environment validation) and an `invoker-cli setup slack` wizard. Doctor checks tools, config, and that your default planning preset's CLI is actually installed (the gap behind silent `spawn cursor ENOENT` failures); setup runs those checks, then — only if you opt in — writes a ready-to-paste Slack app manifest, validates your tokens against the live Slack API, and saves them to `~/.invoker/.env`. The app now loads `~/.invoker/.env` before the Slack startup check (so a populated file just works) and warns on launch when the default preset's tool is missing.
- Add a built-in `omp+codex` Slack planning harness preset (`omp` tool, `codex` model), so `[omp+codex]` lobby tags and a `defaultSlackHarnessPreset` of `omp+codex` resolve without redefining `slackHarnessPresets`.
- Stop treating every lobby/DM `@Invoker` mention as a build request. Mentions and a new `/invoker` slash command now recognize explicit verbs — `status`, `recreate`, `rebase`, `retry`, `cancel` (one workflow or `all`), and `submit` — and run the real workflow operation. A fuzzy operational ask falls back to an LLM classifier that proposes the action and waits for confirmation. Destructive all-workflow operations always confirm (Approve/Cancel buttons or a `yes`/`no` reply), and `submit` shows a plain-English, one-line-per-step summary of the plan to approve instead of raw YAML. The Slack app manifest now enables the `/invoker` slash command and Block Kit interactivity.
- Make Slack lobby mentions normal agent threads by default: plain `@Invoker fix X` now runs a recoverable OMP/Codex-style repo session, `local:` and `run local:` are aliases for that path, workflow count/status questions route to Invoker status directly, `exec local:`/`local command:` run raw shell, and `plan:` is the explicit opt-in for Invoker YAML plus `submit` approval.
- Stream live progress for bulk lobby workflow operations into the Slack thread: a long `recreate`/`rebase`/`cancel all` now edits one in-thread message with a running `done/total` count (and the workflow being processed) as it works, instead of going silent between the "On it…" acknowledgement and the final summary.
- Treat `autoFixRetries` as a real finite cap for auto-fix and CI-repair workers. A value like `3` now stops after three submitted attempts for a failed task instead of enabling unlimited retries.
- Auto-start the auto-fix worker in owner processes and remove direct failed-delta auto-fix scheduling from the app layer. Failures now wake the worker through lifecycle events, then the worker submits the normal fix intent.
- Emit first-class recovery.worker submit/skip audit events from the auto-fix worker and add a mocked browser E2E proving worker-triggered fixes reach the Approve Fix UI.
- Add task deletion across the desktop app, HTTP API, and headless commands. Deleting a task now kills it first when needed, rewires direct dependents to the deleted task's upstream dependencies, and blocks deleting the last task in a workflow so users delete the whole workflow instead.
- Keep the launch dispatcher topping up ready work before each poll, so queued tasks do not sit idle after launch rows expire or are abandoned.

## 0.0.6

- Make `plan-to-invoker` use focused verification by default instead of mandatory `pnpm test` or `pnpm run test:all` gates.
- Bound Action Graph diagnostics to indexed current task data so large databases return quickly.
- Split queue assigning work from running work in the UI pills, queue rows, and task graph.
- Review gates can now track PR stacks with optional dependency order, expose that stack through query surfaces and the side panel, and discard or close stale PRs when the gate is invalidated.
- Model merge-gate PR status as a single `open`/`closed`/`merged` lifecycle so a PR can never be treated as merged and closed at the same time.

## 0.0.5

- Install the bundled `invoker-cli` automatically through the npm UI package and the desktop app.

## 0.0.4

- Publish complete CLI and desktop release assets for npm launcher packages.
- Prepare public npm publication for `@neko-catpital-labs/invoker-cli` and `@neko-catpital-labs/invoker-ui`.

## 0.1.0

- Establish `0.1.0` as the initial documented version baseline for the repository.
- Publish README quick-start guidance for local setup, `run.sh`, and the `plan-to-invoker` skill.
