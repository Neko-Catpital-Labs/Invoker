# Slack-native coding workflows

Drive Invoker from Slack: mention `@Invoker` in a shared **lobby** channel to plan a change against a checked-out repo, then spin the agreed plan up as a workflow. When a workflow starts, Invoker creates a **private `workflow-<id>` channel**, invites you, and posts the workflow there. Mentioning `@Invoker` inside that channel answers using **only that workflow's context** (its planning conversation plus every task transcript) and runs control actions on it.

## Flow

1. **Plan in the lobby.** In the lobby channel: `@Invoker [cursor+codex] [repo:web] add a /health endpoint`. Invoker checks out the repo and runs a planning conversation in the thread.
2. **Confirm.** Reply `go` (or `yes`/`ship it`) to submit the generated YAML plan.
3. **Workflow channel appears.** Invoker creates private `workflow-<id>`, invites you, posts the workflow summary there, and links it from the lobby thread.
4. **Operate in the channel.** `@Invoker status`, `@Invoker approve <task>`, `@Invoker reject <task>`, `@Invoker retry <task>`, `@Invoker input <task>: <text>`, or ask a free-form question (answered only from this workflow's planning + task transcripts).

## Message tags (lobby only)

Leading `[...]` tags select how planning runs. Order does not matter; everything after the tags is the request.

- `[<preset>]` — pick a harness preset (CLI tool + model). No tag ⇒ the default preset.
- `[repo:<alias|git-url>]` — pick the target repo. No tag ⇒ `defaultRepoUrl`.

`@Invoker raise a PR that adds rate limiting` (no tags) uses the default preset and default repo.

## Harness presets

A preset names the **CLI tool** that both plans conversationally and converts the plan to Invoker YAML, plus the **model** it runs. Built-in presets (used when `slackHarnessPresets` is unset):

| Preset | Tool | Model |
| --- | --- | --- |
| `cursor+claude` (default) | cursor | claude |
| `cursor+codex` | cursor | codex |
| `omp+claude` | omp | claude |
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

The fastest path is the setup wizard. It validates your tools, writes a ready-to-paste Slack app
manifest, checks your tokens against the live Slack API, and saves them to `~/.invoker/.env`:

```
invoker-cli setup slack
```

To configure by hand, put these in `~/.invoker/.env` (canonical, loaded on startup before the Slack
check) or `<repoRoot>/.env` (fallback), then run `./run.sh`:

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
SLACK_CHANNEL_ID=C...            # lobby channel (fallback for SLACK_LOBBY_CHANNEL_ID)
SLACK_LOBBY_CHANNEL_ID=C...      # optional; defaults to SLACK_CHANNEL_ID
INVOKER_REPO_URL=git@github.com:acme/web.git   # optional; default repo (else git remote origin)
CURSOR_COMMAND=cursor            # optional planning CLI override
CURSOR_MODEL=...                 # optional planning model override
```

Run `invoker-cli doctor` to confirm your tools, config, and that your default preset's CLI is installed.

## Slack app scopes

The bot runs in Socket Mode. Add these bot scopes to the app manifest (reinstall after changing):

- `app_mentions:read` — receive `@Invoker` mentions.
- `chat:write` — post messages.
- `channels:history` — read lobby thread replies (public lobby channel).
- `groups:write` — **create** private `workflow-<id>` channels and invite users.
- `groups:history` — receive mentions/replies **inside** the private workflow channels.
- `users:read` — resolve users for invites.

Without `groups:write`, channel creation fails; without `groups:history`, the in-channel assistant never sees mentions.

## Scope notes

- Runs on the existing bring-your-own-machine / DigitalOcean SSH single-owner model. No hosted AWS env is required.
- Workflow creation uses `orchestrator.loadPlan` (the same path headless `run` uses); there is no separate HTTP/facade create route today.
- One owner process serves all workflows; "spinning up a planning bot" is a per-thread planning conversation in a per-repo checkout plus a per-workflow channel, all under that one process.
