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

If this session already named Digital Ocean 1 / `remote_digital_ocean_1` / DO1 for that class of work, or already ran deploy/reset/repair against DO1 for admin-bypass PRs, later reset-retries / repair / requeue / ledger edits for those PRs must target DO1 unless the user explicitly says local / this Mac.

Do not clear `~/.invoker/mergify-admin-requeue-state.jsonl` on the Mac and submit repair via the local owner when the live babysitter ledger and cron live on DO1 — that is the wrong machine even when the local dry-run plans the same action.

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
