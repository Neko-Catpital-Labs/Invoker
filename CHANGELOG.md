# Changelog

All notable changes to Invoker will be documented in this file.

## Unreleased

- Add Slack-native coding workflows: plan from a lobby `@Invoker` mention against a checked-out repo with a selectable planning harness (`[preset]`/`[repo:]` tags), spin the plan up as a workflow in a private `workflow-<id>` channel, and drive or question that workflow in-channel using only its own planning conversation and task transcripts.
- Key the single-instance worker lock by worker kind, so different worker kinds can run at once while a second start of an already-running kind is still refused across both worker doors. The worker kind is validated before it becomes the lock filename, so it cannot escape the locks directory.

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
