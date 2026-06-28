# Changelog

All notable changes to Invoker will be documented in this file.

## Unreleased

- Add Slack-native coding workflows: plan from a lobby `@Invoker` mention against a checked-out repo with a selectable planning harness (`[preset]`/`[repo:]` tags), spin the plan up as a workflow in a private `workflow-<id>` channel, and drive or question that workflow in-channel using only its own planning conversation and task transcripts.
- Watch a workflow's progress from two new surfaces beyond the desktop app. A browser surface serves the same UI over HTTP+SSE (enable with `INVOKER_WEB_TOKEN`, open `http://<host>:4200/?token=…`; set `INVOKER_WEB_HOST=0.0.0.0` to reach a remote/headless host), fully interactive via the existing mutation facade. Slack now shows one live status card per mapped `workflow-<id>` channel — a single message edited in place with per-task rows, counts, percent complete, and the PR/review link.
- Key the single-instance worker lock by worker kind, so different worker kinds can run at once while a second start of an already-running kind is still refused across both worker doors. The worker kind is validated before it becomes the lock filename, so it cannot escape the locks directory.
- Cap the `activity_log` table to its most recent 100000 rows, pruned as new entries are written, so `~/.invoker/invoker.db` can no longer grow without bound and trigger SIGBUS crashes.
- Add `invoker-cli doctor` (config-aware environment validation) and an `invoker-cli setup slack` wizard. Doctor checks tools, config, and that your default planning preset's CLI is actually installed (the gap behind silent `spawn cursor ENOENT` failures); setup runs those checks, then — only if you opt in — writes a ready-to-paste Slack app manifest, validates your tokens against the live Slack API, and saves them to `~/.invoker/.env`. The app now loads `~/.invoker/.env` before the Slack startup check (so a populated file just works) and warns on launch when the default preset's tool is missing.
- Add a built-in `omp+codex` Slack planning harness preset (`omp` tool, `codex` model), so `[omp+codex]` lobby tags and a `defaultSlackHarnessPreset` of `omp+codex` resolve without redefining `slackHarnessPresets`.
- Stop treating every lobby/DM `@Invoker` mention as a build request. Mentions and a new `/invoker` slash command now recognize explicit verbs — `status`, `recreate`, `rebase`, `retry`, `cancel` (one workflow or `all`), and `submit` — and run the real workflow operation; anything else is a normal planning conversation that only becomes a workflow when you explicitly `submit`. A fuzzy operational ask falls back to an LLM classifier that proposes the action and waits for confirmation. Destructive all-workflow operations always confirm (Approve/Cancel buttons or a `yes`/`no` reply), and `submit` shows a plain-English, one-line-per-step summary of the plan to approve instead of raw YAML. The Slack app manifest now enables the `/invoker` slash command and Block Kit interactivity.

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
