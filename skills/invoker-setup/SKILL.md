---
name: invoker-setup
description: >
  Get a new machine "good to go" for Invoker and optionally wire up the Slack integration.
  Trigger when asked to set up Invoker, run the setup/tutorial, check the environment,
  fix missing tools, or configure the Slack bot ("set up slack", "/setup", "am I good to go?").
---

# invoker-setup

Agent-driven onboarding. It validates the environment, then — only if the user wants it — walks
them through the Slack integration. Slack is optional; never push it on a user who declines.

## 1. Validate the environment

```bash
invoker-cli doctor --json
```

Read the JSON `checks`. Each has `status` (`ok` | `warn` | `error`), `detail`, and `remediation`.
The desktop System Setup panel shows the same config-aware readiness report as `doctor`: the
canonical tool set (`git`, `pnpm`, `gh`, `docker`, `ssh`, `codex`, `claude`, `cursor`, `omp`),
the config check, planning tools, and the default preset check.

- `error` blocks "good to go" — surface the `remediation` verbatim.
- `warn` is advisory (an optional tool / preset not installed) — mention it, don't block.
- The `default-preset` and `planning-tools` checks are config-aware: an `error` there means the
  configured `defaultSlackHarnessPreset` points at a CLI that is not installed. This is the most
  common Slack failure ("spawn cursor ENOENT") — fix it before going further.

Offer to auto-install missing installable tools:

```bash
invoker-cli doctor --fix
```

`--fix` covers git, pnpm, gh, docker, ssh, codex, claude. `cursor` and `omp` are installed manually
(report their `remediation`).

## 2. Ask about Slack

Ask plainly: "Do you want to set up the Slack integration now?" If no, stop — report that they are
good to go for CLI and UI workflows and that `invoker-cli setup slack` can add Slack later.

## 3. Guided Slack setup (only if they said yes)

Run the wizard, which writes a ready-to-paste app manifest to `~/.invoker/slack-app-manifest.json`
and prompts for the tokens:

```bash
invoker-cli setup slack
```

If you are doing it on the user's behalf (you cannot click api.slack.com), drive it manually:

1. Generate the manifest (the wizard writes it, or you can): it requests bot scopes
   `app_mentions:read, chat:write, channels:history, groups:write, groups:history, users:read`,
   enables Socket Mode, and subscribes to the `app_mention` event.
2. Tell the user: open https://api.slack.com/apps → **Create New App → From a manifest**, pick the
   workspace, paste the manifest JSON, create the app.
3. **Install to Workspace** → copy the Bot User OAuth Token (`xoxb-…`).
4. **Basic Information → App-Level Tokens** → generate one with `connections:write` → copy (`xapp-…`).
5. **Basic Information → App Credentials** → copy the Signing Secret.
6. Invite the bot to the lobby channel; copy that channel ID (starts with `C`).

### The scope gotcha

Adding scopes after install does **not** update the existing token. The user MUST click
**Reinstall to Workspace** or the bot keeps the old (insufficient) scopes. If the scope check fails,
tell them to add the scope **and reinstall**.

## 4. Validate credentials

After the user provides the four values, write them to `~/.invoker/.env` (the wizard does this) and
confirm against the live Slack API:

```bash
invoker-cli setup slack --check
```

This runs `auth.test` (bot token + scopes via the `x-oauth-scopes` header),
`apps.connections.open` (app token / Socket Mode), and `conversations.info` (the lobby channel).
Surface each failing check's `remediation`.

## 5. Done

Tell the user to restart Invoker (or that the next launch picks up `~/.invoker/.env`). On launch the
app logs a one-line prerequisites summary, and the desktop System Setup panel reports the same
canonical tools, config, planning-tools, and default-preset readiness as `invoker-cli doctor`; if the
default preset's tool is missing, the readiness check reports an error while startup still continues,
and if Slack env is incomplete it logs exactly which variable is missing and to run `invoker-cli setup slack`.

## Hard rules

- Never write secrets anywhere except `~/.invoker/.env` (the wizard writes it `0600`). Never echo full
  tokens back to the user or into logs.
- Never invent Slack tokens or fake a successful check. If validation fails, report it.
- Slack is optional. A user who declines is still "good to go" for CLI and UI workflows.
