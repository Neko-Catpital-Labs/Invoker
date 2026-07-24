# Slack-native coding workflows

Drive Invoker from Slack: mention `@Invoker` in any channel where the bot is present to start a normal agent thread in a checked-out repo. If you want an Invoker workflow, say `plan:` first, then submit the drafted plan. When a workflow starts, Invoker creates a **private `workflow-<id>` channel**, invites you, and posts the workflow there. Mentioning `@Invoker` inside that mapped channel answers using **only that workflow's context** (its planning conversation plus every task transcript) and runs control actions on it.

## Flow

1. **Start a normal agent thread.** In any channel where Invoker is present: `@Invoker [omp+codex] [repo:web] fix the Slack routing bug` or `@Invoker fix this in https://github.com/acme/web`. Invoker checks out the selected repo and runs a normal OMP/Codex-style conversation in the thread.
2. **Opt into Invoker planning.** Use `@Invoker plan: add a /health endpoint` when you want YAML for an Invoker workflow instead of direct local agent work. In an existing agent thread, reply `plan: add a /health endpoint`, `plan add a /health endpoint`, or `add a /health endpoint via Invoker`; Invoker promotes that same thread to planning and retains its selected repo and harness preset.
3. **Submit only when ready.** Run `@Invoker submit` in that plan thread, then approve the short summary. That starts the generated YAML plan as a workflow.
4. **Workflow channel appears.** Invoker creates private `workflow-<id>`, invites you, posts the workflow summary there, and links it from the originating plan thread.
5. **Operate in the channel.** `@Invoker status`, `@Invoker approve <task>`, `@Invoker reject <task>`, `@Invoker retry <task>`, `@Invoker input <task>: <text>`, or ask a free-form question (answered only from this workflow's planning + task transcripts).

## Message tags

Leading `[...]` tags select how planning runs. Order does not matter; everything after the tags is the request.

- `[<preset>]` — pick a harness preset (CLI tool + model). No tag ⇒ the default preset.
- `[repo:<alias|git-url>]` — explicitly pick the target repo. One unambiguous GitHub or git URL in the tagged request also selects that repo. Multiple URLs, or a URL that conflicts with `[repo:…]`, are rejected. No selector ⇒ `defaultRepoUrl`.

`@Invoker raise a PR that adds rate limiting` (no tags) uses the default preset and default repo as a normal agent thread.

The repository and harness are pinned when the thread starts. Start a new thread to use another repository or preset.

## Local and plan modes

Normal mentions outside mapped workflow channels are local agent sessions. They can answer, edit, and run focused checks in their repo worktree.

- `@Invoker fix the typo in the Slack docs` — starts or continues a normal agent thread.
- `@Invoker local: fix the typo in the Slack docs` — kept as an alias for the same normal agent thread.
- `@Invoker run local: report back how many workflows are running` — answers through Invoker status directly. Other local queries use the normal agent thread.
- `@Invoker exec local: pnpm --filter @invoker/surfaces test -- slack-surface-workflows.test.ts` — runs that exact shell command and reports the exit code and output. It does **not** edit files.
- `@Invoker plan: fix the typo in the Slack docs` — drafts Invoker YAML. Use `@Invoker submit` (or bare `submit`) in that thread to start the approval flow.
- `plan: turn the discussion above into a migration plan` — promotes the current agent thread to plan mode, keeping its repo and harness selection. This works after a Slack service restart as well.
- `turn the discussion above into a plan` — promotes the current agent thread without requiring a second thread.

## Harness presets

A preset names the **CLI tool** that both plans conversationally and converts the plan to Invoker YAML, plus the **model** it runs. Built-in presets (used when `slackHarnessPresets` is unset):

| Preset | Tool | Model |
| --- | --- | --- |
| `cursor+claude` (default) | cursor | claude |
| `cursor+codex` | cursor | codex |
| `omp+claude` | omp | claude |
| `omp+codex` | omp | codex |
| `omp` | omp | (CLI default) |
| `codex` | codex | (CLI default) |

Override them in `~/.invoker/config.json`:

```json
{
  "slackHarnessPresets": {
    "omp+claude": { "tool": "omp", "model": "anthropic/claude-opus-4" },
    "codex": { "tool": "codex" }
  },
  "defaultSlackHarnessPreset": "omp+claude",
  "slackRepos": {
    "web": "git@github.com:acme/web.git",
    "api": "git@github.com:acme/api.git"
  },
  "defaultRepoUrl": "git@github.com:acme/web.git"
}
```

Model strings are passed verbatim to the CLI's `--model`; set exact ids your CLI accepts. Plain `codex` ignores the model (uses the CLI default). The generated workflow's per-task `executionAgent` is whatever the `plan-to-invoker` skill writes, defaulting to the chosen preset's tool when the skill leaves it unset.

## Environment

Slack runs as a **separate** always-on process (`invoker-slack`), not inside the
desktop app. Install the published binary with:

```
npm install -g @neko-catpital-labs/invoker-slack
```

Or cut a local binary with `bash scripts/local-macos-release-build.sh` (see
[local-macos-release-build.md](local-macos-release-build.md)).

The fastest credential path is the setup wizard. It validates your tools, writes a ready-to-paste Slack app
manifest, checks your tokens against the live Slack API, and saves them to `~/.invoker/.env`:

```
invoker-cli setup slack
```

For the Slack manager daemon, also put owner credentials in `~/.invoker/.slack-owner.env`
(or set `INVOKER_SLACK_OWNER_ENV`). Keep the default harness preset in
`~/.invoker/config.json`, where `defaultSlackHarnessPreset` is already
documented. The standalone manager reads that config first, then falls back to
`INVOKER_SLACK_DEFAULT_PRESET` only when the config leaves the preset unset.
To configure by hand, put these credential values in `~/.invoker/.env`
(canonical, loaded on startup before the Slack check) or `<repoRoot>/.env`
(fallback), then run `invoker-slack` (or `./run.sh` for the desktop app only):

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
SLACK_CHANNEL_ID=C...            # default channel (fallback for SLACK_LOBBY_CHANNEL_ID)
SLACK_LOBBY_CHANNEL_ID=C...      # optional default/home channel
INVOKER_REPO_URL=git@github.com:acme/web.git   # optional; default repo (else git remote origin)
CURSOR_COMMAND=cursor            # optional planning CLI override
CURSOR_MODEL=...                 # optional planning model override
```

Run `invoker-cli doctor` to confirm your tools, config, and that your default preset's CLI is installed.
The desktop System Setup panel mirrors the doctor for tool and config readiness.

## Slack app scopes

The bot runs in Socket Mode. Add these bot scopes to the app manifest (reinstall after changing):

- `app_mentions:read` — receive `@Invoker` mentions.
- `chat:write` — post messages.
- `files:write` — upload artifacts an agent links from its worktree.
- `channels:history` — read thread replies in public channels where Invoker is used.
- `channels:read` — resolve the configured default channel via `conversations.info` during setup checks.
- `groups:write` — **create** private `workflow-<id>` channels and invite users.
- `groups:history` — receive mentions/replies **inside** the private workflow channels.
- `users:read` — resolve users for invites.

Without `groups:write`, channel creation fails; without `groups:history`, the in-channel assistant never sees mentions.

## Scope notes

- Runs on the existing bring-your-own-machine / DigitalOcean SSH single-owner model. No hosted AWS env is required.
- Workflow creation uses `orchestrator.loadPlan` (the same path headless `run` uses); there is no separate HTTP/facade create route today.
- One owner process serves all workflows; "spinning up a bot" is a per-thread agent or plan conversation in a per-repo checkout plus a per-workflow channel, all under that one process.
