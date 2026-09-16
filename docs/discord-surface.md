# Discord surface

Drive Invoker from a Discord server: mention `@Invoker` in any server text channel the bot can see, and Invoker opens a **thread on that message** and starts a normal agent conversation in a checked-out repo. When the scope is ready, run `/plan` in the thread. Invoker posts a durable review message with the ordered steps, the exact YAML as a file attachment, and **Approve** and **Cancel** buttons. Approving creates a **private `workflow-<id>` channel**, grants you access, posts the workflow there, and links it back from the plan thread. Mentioning `@Invoker` inside that channel runs controls on that workflow and answers questions from **that workflow's context alone**.

The Discord surface mirrors the Slack surface ([slack-native-workflows.md](slack-native-workflows.md)) and runs on the same approval core, but it has its own setup and its own platform limits, listed below.

## Flow

1. **Mention the bot in a channel.** In a server text channel: `@Invoker [codex] [repo:web] fix the rate limiter`. Invoker opens a thread on your message (named after the request) and starts a planning session keyed by `(surface, channelId, threadId)`, i.e. `discord:<parent channel id>:<thread id>`. All replies go into the thread, never the parent channel.
2. **Keep talking in the thread.** Mentioning `@Invoker` inside that thread continues the same session. It never opens a nested thread and never starts a second session for the same thread.
3. **Create a plan explicitly.** Run the `/plan` slash command inside the thread, or send `@Invoker /plan` there. Both convert the thread's conversation, pinned repo and preset into Invoker YAML and post the review message in the thread. `/plan` outside a planning thread, or in a thread with no conversation yet, posts nothing and says why.
4. **Review and approve.** The review message lists the plan steps in order, attaches the full plan as a `.yaml` file, and carries **Approve** and **Cancel** buttons. It does not expire. **Cancel** keeps the draft (the message changes to *Plan not submitted. Draft kept.* with **Approve** and **Discard draft**), so you can still approve it later. Only the user who requested the plan can approve it, only from the thread it was posted in, and a second click never starts a second workflow.
5. **Workflow channel appears.** Approve starts that exact YAML as a workflow. Invoker creates a private text channel `workflow-<id>`, grants the requester access, posts *Workflow `<id>` is running here* plus the workflow summary (steps and YAML attachment), and posts a `#workflow-<id>` link back in the plan thread.
6. **Operate in the channel.** Mention the bot with one of:
   - `@Invoker status`
   - `@Invoker approve <task>`
   - `@Invoker reject <task>`
   - `@Invoker retry <task>`
   - `@Invoker input <task>: <text>`
   - any free-form question, answered only from this workflow's planning conversation and task transcripts.

   `<task>` is the task id inside the plan; Invoker scopes it to this channel's workflow (`<workflowId>/<task>`), so a command in one workflow channel can never touch another workflow. Mentions inside a thread under the workflow channel are routed to the same workflow.

Typing `approve`, `submit`, `yes`, a YAML fence, or a button id as plain text never starts a workflow. Plans only start from the **Approve** button on the review message.

## Message tags

Leading `[...]` tags select how planning runs. Order does not matter; everything after the tags is the request.

- `[<preset>]` — pick a harness preset (CLI tool + model). No tag ⇒ the default preset.
- `[repo:<alias|git-url>]` — explicitly pick the target repo. One unambiguous GitHub or git URL in the request also selects that repo. Multiple URLs are rejected. No selector ⇒ the channel's repo binding, else `defaultRepoUrl`.

The repository and preset are pinned when the thread starts. A later mention in the same thread that names a different repo or preset is refused; start a new thread instead.

## Planning threads

Planning threads are exploration sessions, the same as normal Slack agent threads.

- `@Invoker /plan` or `/plan` — convert the current thread into a review message.
- `@Invoker /plan <request>` — asks whether you want an executable plan, with **Plan for execution** and **No planning, just continue conversation** buttons. The plan is drafted only after you click **Plan for execution**; the choice cannot be replayed.
- `@Invoker` with no text — replies with a greeting inside a new thread.

Not available in Discord planning threads: workflow operations, restarts, `run local:` / `exec local:` commands, auto-submit, and channel repo setup. Invoker replies saying so. Workflow controls only work inside a `workflow-<id>` channel.

## Harness presets

A preset names the **CLI tool** that plans conversationally and converts the plan to YAML, plus the **model** it runs. Built-in presets:

| Preset | Tool | Model |
| --- | --- | --- |
| `codex` (default) | codex | (CLI default) |
| `claude` | claude | (CLI default) |
| `cursor+claude` | cursor | claude |
| `cursor+codex` | cursor | codex |
| `omp+claude` | omp | claude |
| `omp+codex` | omp | codex |
| `omp` | omp | (CLI default) |

Add or override presets with the surface's `harnessPresets` option, and change the default with `defaultHarnessPreset` (see [Running the surface](#running-the-surface)). An unknown `[<preset>]` tag is answered with the list of valid presets.

## Discord application setup

Do this once per bot, in the [Discord Developer Portal](https://discord.com/developers/applications).

1. **Create an application**, open **Bot**, and use **Reset Token** to get the bot token. Store it in a secret store or an untracked env file; never commit it or paste it into a channel.
2. **Privileged Gateway Intents:** leave **Message Content Intent**, **Server Members Intent** and **Presence Intent** off. The surface does not use them; see [MESSAGE_CONTENT](#message_content-intent).
3. **Optional:** turn **Public Bot** off so only you can add the bot to servers.
4. **Invite the bot.** Open **OAuth2 → URL Generator**, tick the scopes in [OAuth scopes](#oauth-scopes) and the permissions in [Bot permissions](#bot-permissions), open the generated URL, and choose your server. Equivalently, fill in this URL with your application id:

   ```
   https://discord.com/oauth2/authorize?client_id=<APPLICATION_ID>&scope=bot+applications.commands&permissions=309506182160
   ```

   Use `permissions=326686051344` instead for a bot that also runs the [live harness](#live-harness).
5. **Copy ids.** In the Discord client, enable **User Settings → Advanced → Developer Mode**, then right-click a server, channel or user and choose **Copy ID**. You need the server (guild) id and, optionally, an alert channel id.

Changing the scopes or permissions later means re-inviting the bot with the new URL, or editing the bot's role under **Server Settings → Roles**.

### OAuth scopes

| Scope | Why |
| --- | --- |
| `bot` | Adds the bot user to the server so it can connect to the gateway, read mentions and post. |
| `applications.commands` | Lets the bot register the `/plan` slash command. Without it, registration fails (logged as *Failed to register the /plan command*) and only `@Invoker /plan` works. |

### Gateway intents

The client connects with exactly two intents, both non-privileged:

| Intent | Bit | Why |
| --- | --- | --- |
| `GUILDS` | `1 << 0` | Channel, thread and guild state. |
| `GUILD_MESSAGES` | `1 << 9` | Receive message-create events in server channels and threads. |

`DIRECT_MESSAGES` is not requested, so the bot never sees DMs. Mention it in a server channel.

### MESSAGE_CONTENT intent

`MESSAGE_CONTENT` (`1 << 15`) is a privileged intent, and the surface does **not** request it. It is unnecessary **only while every message the surface acts on mentions the bot**: without the intent, Discord still delivers the content of messages that mention the bot user, and the surface ignores every message that does not mention it.

Consequences:

- Mention the **bot user**, not a role that shares its name. Discord's autocomplete often offers the bot's managed role (`@Invoker` with a role colour); a role mention is not a mention of the bot and is ignored.
- If a message mentions the bot but still arrives with empty content, the surface logs a warning tagged `[DISCORD_EMPTY_CONTENT]` with the message, channel and author ids and does not treat it as a request.
- Turning on the portal toggle alone changes nothing, because the client does not request the intent. Any future behaviour that reads messages without a mention needs both the portal toggle and a code change to request the intent.

### Bot permissions

Grant these on the bot's role at **server level**. Discord only lets a bot allow or deny permissions it holds itself, and the bot grants some of these to members on each workflow channel, so per-channel overrides are not enough. Do not grant **Administrator**.

| Permission (API name) | Bit | Value | Needed for |
| --- | --- | --- | --- |
| View Channels (`VIEW_CHANNEL`) | `1 << 10` | 1024 | See the channel where it is mentioned; grant access to workflow channels. |
| Send Messages (`SEND_MESSAGES`) | `1 << 11` | 2048 | Post in workflow channels and the alert channel; report a thread-creation failure in the parent channel. |
| Send Messages in Threads (`SEND_MESSAGES_IN_THREADS`) | `1 << 38` | 274877906944 | Every reply in a planning thread, including the review message. |
| Create Public Threads (`CREATE_PUBLIC_THREADS`) | `1 << 35` | 34359738368 | Open the planning thread on the mention. |
| Read Message History (`READ_MESSAGE_HISTORY`) | `1 << 16` | 65536 | Fetch a message by id to start a thread on it or edit it in place (progress card, review message, button state). |
| Attach Files (`ATTACH_FILES`) | `1 << 15` | 32768 | Attach the plan YAML to the review message and the workflow summary. |
| Manage Channels (`MANAGE_CHANNELS`) | `1 << 4` | 16 | Create the private `workflow-<id>` channel. |
| Manage Roles (`MANAGE_ROLES`, shown as *Manage Permissions* on a channel) | `1 << 28` | 268435456 | Set the permission overwrites that make the workflow channel private, and add the requester to an existing `workflow-<id>` channel. |

Total for the surface: **309506182160**.

The [live harness](#live-harness) additionally needs:

| Permission (API name) | Bit | Value | Needed for |
| --- | --- | --- | --- |
| Manage Threads (`MANAGE_THREADS`) | `1 << 34` | 17179869184 | Delete the test thread during cleanup. |

Total for a bot that also runs the harness: **326686051344**. The harness's own `--help` text lists its permissions without Manage Roles; grant the full set above, because the harness creates a real private workflow channel.

What a missing permission looks like:

| Missing | Symptom |
| --- | --- |
| `CREATE_PUBLIC_THREADS` | The channel gets *I could not open a planning thread here: …*; logged as `[THREAD] Failed to open a thread`. |
| `SEND_MESSAGES_IN_THREADS` | The thread opens but stays empty; send errors are logged. |
| `ATTACH_FILES` | The review message fails to post; the thread gets *I hit an error trying to prepare the plan review* naming the draft id, and a critical alert goes to the alert channel. |
| `MANAGE_CHANNELS` or `MANAGE_ROLES` | The workflow starts but no channel appears; the plan thread gets *Could not create a channel for workflow `<id>`: …*. |
| `applications.commands` scope | `/plan` does not appear; `@Invoker /plan` still works. |

## Workflow channels

- **Name:** `workflow-<id>` with the `wf-` prefix dropped, lowercased, any character outside `a-z 0-9 - _` replaced by `-`, capped at 100 characters. Workflow `wf-1789-4` gets `workflow-1789-4`.
- **Location:** the server that owns the plan thread; the `guildId` option is the fallback when that cannot be resolved.
- **Access:** `@everyone` is denied View Channels. The requester gets View Channels, Send Messages and Read Message History. The bot gets the same plus Attach Files. Server members with Administrator can still see every channel; that is Discord's rule, not something the bot can override.
- **Reuse:** if a text channel with that name already exists, the bot adds the requester to it instead of creating another.
- **Updates:** workflow progress is posted once and then edited in place; the message id is stored with the channel mapping, so edits continue after a restart. A task gets one message when created, edited as its status changes. Updates for a workflow with no mapped channel are dropped and logged as `[WORKFLOW_EVENT] Suppressed unmapped workflow update`.
- **Alerts and errors** go to `alertChannelId`. With no alert channel they are dropped and logged as `[ALERT] No alert channel configured`.

## Discord limits

These have no Slack equivalent and shape the surface's behaviour.

- **Three-second interaction acknowledgement.** Discord invalidates a button click or slash command that is not acknowledged within **3 seconds**. The surface acknowledges every interaction before doing any other work, including unknown actions: a button is acknowledged with a deferred update, and `/plan` with a deferred ephemeral reply. The real work happens afterwards and reports back through an ephemeral follow-up or by editing the deferred reply. Discord keeps that interaction token valid for 15 minutes, so if plan conversion runs longer, the ephemeral *Posted the plan review* confirmation fails and is logged, but the review message itself still posts in the thread.
- **2000-character message cap.** Discord rejects message content over **2000 characters** (Slack's chunker uses 3,800). Every post, edit and ephemeral notice is fitted to 2000 characters. Long agent replies are split into several messages. The review message body lists as many steps as fit and ends with *… N more steps in the attached YAML*; the attachment always carries the full plan. Agent replies have absolute filesystem paths redacted before posting.
- **Buttons:** at most five per row; the surface packs them automatically.
- **Mentions:** outgoing messages never ping anyone (`allowedMentions` is empty); channel links such as `#workflow-<id>` still render.

## Running the surface

Unlike Slack, Discord has no standalone daemon, CLI setup wizard, or `~/.invoker/config.json` keys yet. The surface ships as the `@invoker/discord` workspace package, and a host process constructs it and wires it to the orchestrator:

```ts
import { DiscordJsGateway, DiscordSurface } from '@invoker/discord';
import { SQLiteAdapter, SlackPlanDraftRepository, WorkflowChannelRepository } from '@invoker/data-store';

const adapter = await SQLiteAdapter.create(databasePath);
const surface = new DiscordSurface({
  gateway: new DiscordJsGateway({ token: process.env.DISCORD_BOT_TOKEN!, commandGuildIds: [guildId] }),
  planDraftRepo: new SlackPlanDraftRepository(adapter),
  workflowChannelRepo: new WorkflowChannelRepository(adapter),
  gatherWorkflowContext,
  defaultRepoUrl: 'git@github.com:acme/web.git',
  guildId,
  alertChannelId,
});
await surface.start(onCommand);
```

The host's `onCommand` receives the surface's commands: `start_plan` (from Approve; return `{ workflowIds }`), `get_status`, `approve`, `reject`, `retry` and `provide_input`. Orchestrator events reach the surface through `surface.handleEvent(event)`; the host must send a `workflow_created` event (with `requestedBy`, `lobbyChannel` and `planFile` from the `start_plan` command) for the workflow channel to be created.

`DiscordJsGateway` options:

| Option | Meaning |
| --- | --- |
| `token` | Bot token. Read it from the environment or a secret store. |
| `commandGuildIds` | Register `/plan` in these servers only. Omit to register it globally for the application. |
| `onHandlerError` | Receives errors thrown by message and interaction handlers; defaults to `console.error`. |

`DiscordSurface` options:

| Option | Default | Meaning |
| --- | --- | --- |
| `gateway` | required | The `DiscordJsGateway` above. |
| `planDraftRepo` | none | Stores review drafts. Without it `/plan` answers *Plan reviews are not configured in this deployment.* |
| `workflowChannelRepo` | none | Maps workflows to channels. Without it, mentions in workflow channels are not routed and workflow updates are dropped. |
| `gatherWorkflowContext` | none | Loads a workflow's planning and task transcripts for free-form questions. Without it, questions get *Workflow context is not available in this deployment.* |
| `defaultRepoUrl` | none | Repo used when a request names none. |
| `repoAliases` | `{}` | `[repo:<alias>]` → repo URL. |
| `channelRepoBindings` | `{}` | Parent channel id → default repo URL for that channel. |
| `prepareRepoCheckout` | none | Checks out a repo for a thread and returns its working directory. |
| `workingDir` | none | Working directory for `defaultRepoUrl` and for workflow questions. |
| `harnessPresets` | built-ins | Extra or overriding presets. |
| `defaultHarnessPreset` | `codex` | Preset used when a request has no preset tag. |
| `guildId` | none | Fallback server for workflow channels. |
| `alertChannelId` | none | Channel for alerts and errors. |
| `registerSlashCommands` | `true` | Register `/plan` on start. Registration failure is logged and does not stop the surface. |
| `cursorCommand`, `planningCommandBuilder` | `agent` CLI | How the planner CLI is invoked. |
| `defaultBranch` | none | Base branch passed to the planner. |
| `planningTimeoutSeconds` | `7200` | Planner turn timeout. |
| `log` | console | `(source, level, message)` logger. |

Planning sessions and each thread's pinned repo and preset live in the process's memory. Review drafts and workflow-channel mappings live in the data store, so review messages and workflow channels keep working across restarts.

## Tests

Hermetic, no credentials, no network:

```
pnpm --filter @invoker/discord test
node scripts/test-discord-live-e2e.mjs
pnpm --filter "@invoker/discord..." build && node scripts/test-discord-live-e2e-loop.mjs
```

The first runs the surface against a fake gateway: plan loop, approval guard, the 2000-character cap, acknowledge-first ordering, and the empty-content log. The second proves the live harness's guild guard and exit codes with networking blocked and checks it never prints the token. The third drives the harness's full loop and cleanup against an in-memory fake Discord using the real surface bundle.

## Live harness

`scripts/discord-live-e2e.mjs` drives the whole loop against a **real Discord test server**: mention, thread, `/plan`, review message, Approve, private workflow channel, progress edits, and workflow-channel controls and questions. It then deletes everything it created. The planner and orchestrator are scripted stand-ins; the Discord side is real.

Use a **dedicated test server** that holds nothing you care about; never point it at a working server. The bot must be a member with the harness permission set above, and the server owner must be a human account (driven mode acts as the owner).

Build first:

```
pnpm install && pnpm --filter "@invoker/discord..." build
```

Environment (all required):

| Variable | Meaning |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Token of a bot that is a member of the test server. Never printed. |
| `DISCORD_TEST_GUILD_ID` | The only server the harness will touch. |
| `DISCORD_TEST_CHANNEL_ID` | A text channel inside that server. |

Commands:

```
node scripts/discord-live-e2e.mjs --check-config
node scripts/discord-live-e2e.mjs
node scripts/discord-live-e2e.mjs --interactive
```

| Option | Effect |
| --- | --- |
| `--check-config` | Validates the variables and the guild guard with no network call. |
| *(none)* | Driven mode: the bot posts the mentions itself and the `/plan` and Approve interactions are synthesized, so no human is needed. `/plan` is not registered. |
| `--interactive` | Waits (up to 5 minutes per step) for a person in the test server to mention the bot, run `/plan` and click Approve, following instructions the harness posts. This is the only mode where the mention content and the three-second acknowledgement come from Discord itself, so use it to confirm the MESSAGE_CONTENT condition and the acknowledgement deadline. It registers `/plan` as a server command and leaves it in place. |
| `--guild <id>` | Target server; refused unless it equals `DISCORD_TEST_GUILD_ID`. |
| `--verbose` | Prints the surface's info logs. |

Each step prints `ok - …` or `not ok - …`, then one line `discord-live-e2e: PASS|FAIL|UNCHECKED [REASON] detail`.

| Exit code | Outcome |
| --- | --- |
| `0` | `PASS`: every step passed and cleanup removed everything the harness created. |
| `1` | `FAIL`, with a reason such as `STEP_FAILED`, `GUILD_GUARD_REFUSED`, `CLEANUP_INCOMPLETE`, `BUILD_MISSING`, `INVALID_CONFIG` or `INTERRUPTED`. |
| `2` | `UNCHECKED`: a variable is missing, so nothing was checked. This is never a pass. |

Safety rails:

- Every write (thread, message, edit, channel) first checks that the target channel belongs to `DISCORD_TEST_GUILD_ID`; anything else fails the run with `GUILD_GUARD_REFUSED`.
- Every interaction must be acknowledged within 3000 ms and before any other Discord write, or the step fails.
- Cleanup deletes only threads, channels and messages the harness created, and reports anything it could not remove (`cleanup: COULD NOT REMOVE …`, outcome `CLEANUP_INCOMPLETE`). Items that existed before the run, operator messages, and the registered `/plan` command are reported as *left in place*.
- Ctrl-C cleans up before exiting.

The harness is a manual check (`scripts/test-suites/regression-inventory.yaml`, id `discord-live-e2e`); no CI job holds the credentials it needs.

## Scope notes

- Server text channels and their threads only; DMs are never received.
- One process, one bot token. Planning conversations run in per-repo checkouts on the host's machine, the same single-owner model as Slack.
- Workflow creation goes through the same plan-draft approval state machine as Slack; Discord adds no other way to start a workflow.
