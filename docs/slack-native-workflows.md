# Slack-native coding workflows

Drive Invoker from Slack: mention `@Invoker` in any channel where the bot is present to start a normal agent thread in a checked-out repo. When the scope is ready, use `@Invoker /plan` in that same thread. Invoker posts a durable review message with the exact YAML attachment and Approve/Cancel buttons. When a workflow starts, Invoker creates a **private `workflow-<id>` channel**, attempts to invite the authenticated requester, and posts the workflow there. Mentioning `@Invoker` inside that mapped channel answers using **only that workflow's context** (its planning conversation plus every task transcript) and runs control actions on it.

## Flow

1. **Start a normal agent thread.** In any channel where Invoker is present: `@Invoker [omp+codex] [repo:web] fix the Slack routing bug` or `@Invoker fix this in https://github.com/acme/web`. Invoker checks out the selected repo and runs a normal OMP/Codex-style conversation in the thread.
2. **Create a plan explicitly.** Use `@Invoker /plan` in the established thread. It uses the same thread history, pinned repo, and harness preset to convert the agreed scope to Invoker YAML.
3. **Review and approve.** The review message contains newline-delimited steps, the exact YAML attachment, and Approve/Cancel buttons. It is durable: it does not expire. Only the authenticated Slack user who requested the draft can approve it; approval starts that exact YAML plan as a workflow.
4. **Workflow channel appears.** Invoker creates private `workflow-<id>`, invites that authenticated requester, posts the workflow summary there, and links it from the originating plan thread.
5. **Operate in the channel.** `@Invoker status`, `@Invoker approve <task>`, `@Invoker reject <task>`, `@Invoker retry <task>`, `@Invoker input <task>: <text>`, or ask a free-form question (answered only from this workflow's planning + task transcripts).

## In-app workflow channels

Map successful planning-chat submissions from the desktop app to an operator-owned Slack identity and lobby in `~/.invoker/config.json`:

```json
{
  "slackInAppRequesterId": "U0123456789",
  "slackLobbyChannelId": "C0123456789"
}
```

`slackInAppRequesterId` is the trusted Slack user ID invited to private workflow channels; it cannot be supplied by the renderer. `slackLobbyChannelId` is where each channel link is posted. Both values are required for this bridge.

After a successful in-app submission, Invoker creates one idempotent private channel for each returned workflow, including each workflow in a stack. It posts each channel link as a root message in `slackLobbyChannelId`, not in a lobby thread. Re-delivering the same workflow-created event reuses the persisted mapping and does not create a channel or republish its content.

If the trusted requester or lobby configuration is missing or blank, the in-app workflow still starts, but Slack channel provisioning is skipped and no channel-created success message is posted.

## Workflow channel routing and invite failures

If Slack cannot invite the requester, Invoker keeps the workflow-to-channel mapping and posts the private channel link at the same origin location with an explicit warning that the requester was not invited and the Slack error reason. It does not claim that the requester joined.

Workflow progress, task changes, status, and other ongoing workflow messages are posted or updated only in that workflow's mapped private channel. Events for an unmapped workflow are suppressed; they never fall back to the lobby, the originating thread, or another workflow's channel.

## Message tags

Leading `[...]` tags select how planning runs. Order does not matter; everything after the tags is the request.

- `[<preset>]` — pick a harness preset (CLI tool + model). No tag ⇒ the default preset.
- `[repo:<alias|git-url>]` — explicitly pick the target repo. One unambiguous GitHub or git URL in the tagged request also selects that repo. Multiple URLs, or a URL that conflicts with `[repo:…]`, are rejected. No selector ⇒ `defaultRepoUrl`.

`@Invoker raise a PR that adds rate limiting` (no tags) uses the default preset and default repo as a normal agent thread.

The repository and harness are pinned when the thread starts. Start a new thread to use another repository or preset.

When the harness preset supports it, Invoker resumes the same underlying agent session across turns and across a Slack manager restart (append-based continuity) instead of replaying the full prompt history each time.

## Local and plan modes

Normal mentions outside mapped workflow channels are exploration sessions. They can answer and create repro artifacts, but tracked files are restored and the turn fails if the agent modifies them before plan approval.

- `@Invoker fix the typo in the Slack docs` — starts or continues a normal agent thread.
- `@Invoker local: fix the typo in the Slack docs` — kept as an alias for the same normal agent thread.
- `@Invoker run local: report back how many workflows are running` — answers through Invoker status directly. Other local queries use the normal agent thread.
- `@Invoker exec local: pnpm --filter @invoker/surfaces test -- slack-surface-workflows.test.ts` — runs that exact shell command and reports the exit code and output. It does **not** edit files.
- `@Invoker /plan` — converts the current thread into a YAML review message without changing its pinned repository or preset.
- Plain text such as `plan`, `submit`, or YAML fences does not create or execute a workflow.

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
(fallback), then run `invoker-slack` (or `invoker-ui` for the desktop app only):

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
