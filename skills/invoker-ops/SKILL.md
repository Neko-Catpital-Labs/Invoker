---
name: invoker-ops
description: >
  Safely operate existing Invoker workflows and tasks from natural-language requests.
  Trigger when asked to list, inspect, retry, restart, resume, cancel, approve,
  reject, or check pending/failed/running Invoker tasks or workflows.
---

# invoker-ops

Use this skill for operator requests against existing Invoker state.

Examples:

- "restart all failing tasks"
- "retry all pending tasks"
- "what is blocked?"
- "show me running workflows"
- "cancel this task"

## Hard rule

Do not query or mutate the SQLite database directly for normal operations.

Use Invoker commands first. Direct database reads are only allowed when the user explicitly asks to debug persistence/storage internals, or when the Invoker command surface itself is the broken thing being investigated.

## Sticky admin-bypass host

Admin-bypass babysitting (`pr-admin-bypass-land` / `mergify_admin_requeue`, repair-filing claims, retry-cap ledger clears, and requeue for a named admin-bypass PR) is host-sticky for the session.

If this session already named a remote host for that class of work, or already ran deploy/reset/repair against that host for admin-bypass PRs, later reset-retries / repair / requeue / ledger edits for those PRs must target the same host unless the user explicitly says local / this machine.

Do not clear `~/.invoker/mergify-admin-requeue-state.jsonl` on a different machine and submit repair via that owner when the live babysitter ledger and cron live on the session's chosen host — that is the wrong machine even when a local dry-run plans the same action.

Require an explicit "local" / "this machine" to switch hosts mid-session.

## Safe command map

### List workflows

```bash
invoker-ui --headless query workflows --output text
invoker-ui --headless query workflows --status failed --output json
```

### List tasks

```bash
invoker-ui --headless query tasks --workflow <workflowId> --output text
invoker-ui --headless query tasks --workflow <workflowId> --status pending --output json
invoker-ui --headless query tasks --workflow <workflowId> --status failed --output json
invoker-ui --headless query tasks --workflow <workflowId> --status running --output json
```

If the request says "all workflows", first list workflows, then query each workflow through `query tasks --workflow <workflowId>`.

### Retry failed tasks

```bash
invoker-ui --headless retry-tasks --status failed --parallel 8
```

### Retry pending tasks

```bash
invoker-ui --headless retry-tasks --status pending --parallel 8
```

### Dry-run a bulk retry

```bash
invoker-ui --headless retry-tasks --status pending --parallel 8 --dry-run
```

### Retry one task

```bash
invoker-ui --headless retry-task <taskId> --no-track
```

### Retry one workflow

```bash
invoker-ui --headless retry <workflowId> --no-track
```

## Acknowledgement boundary

Bulk retry commands must use `--no-track`.

The operator acknowledgement means the retry request was accepted for dispatch. It does not mean the task finished.

After submitting, verify with query commands, not database reads.

## Workflow for "retry/restart all failed or pending tasks"

1. Run a dry-run if the request is broad or destructive-looking.
2. Run `invoker-ui --headless retry-tasks --status <status> --parallel 8`.
3. Report accepted and failed submission counts from command output.
4. Verify remaining tasks with `query tasks` commands when the user asks for current state.

## If a command is missing

Do not invent SQL as the fallback.

Report the missing command surface and add/fix the command if the user asked for a durable production-safe path.

## State claims must be fresh

Never report a workflow/task count, CI status, merge status, or "it's running"/"it's fixed"/"autofix kicked in" from memory of an earlier check in this conversation. Run the query command again in the same turn and report what it actually returns now. State drifts between when you last checked and when you answer — a count from five minutes ago is not current state. See `skills/prove-it/SKILL.md`.

## `needs_input` with empty task output is a read-the-reason problem

A task that goes `needs_input` seconds after submit, with empty task output and no agent session, was stopped by the owner before launch. The stop reason is stored in `execution.inputPrompt`, and no headless query projection emits that field (`query task`, `query tasks`, `invoker_list_tasks`, and `/api/tasks` all go through the same serializer).

Do this, in order, before any `retry-task`, agent switch (`set agent`), or resubmit:

1. Print the returned key set of the task record, not just truthy values. If `inputPrompt` is not among the keys, say "not projected", not "empty". Absence of a field is not absence of state.
2. Read the emitter in the running owner. The installed app bundle is greppable: `grep -n "ANCHOR_CLAUSE_PATTERN\|inputPrompt" /Applications/Invoker.app/Contents/Resources/app.asar`. Read the owner's copy, not the checkout's — a checkout can carry an untracked or unmerged rewrite of the same file.
3. On macOS, `invoker-ui --headless ...` goes through `open -a` and discards stdout and the exit code, so an empty result proves nothing. Call the binary directly: `/Applications/Invoker.app/Contents/MacOS/Invoker --headless query task <taskId> --output json`.
4. Only after the reason is in hand, reword the task or choose the operator action. A retry against the same task text reproduces the same stop.

Do not hand the lookup back to the user ("open the task in the app and paste the text") until steps 1-3 have been tried and shown.

## Waiting on a workflow

Once a background `invoker-cli wait <workflowId>` is armed on a workflow, do not also poll it with foreground `sleep`/`seq` loops around `invoker-cli query`. One waiter per workflow; the wake-up is the signal.

When the session context is already large and a workflow is stuck, delegate the digging (owner log reads, bundle greps, key-set dumps) to a subagent and keep only its conclusion in the main context.

## Cancelling a chain

Cancelling a chain head releases its chained downstream workflows: their merge-gate dependency detaches and their implement tasks launch on plain master seconds later. Cancel downstream workflows first, then the head.

After each cancel, re-query with `query tasks --workflow <workflowId>` until every task shows `failed`. A cancel of a still-pending workflow may not stick on the first call, and the app-binary cancel exit code is unreliable, so the query result is the only proof that the cancel took.
