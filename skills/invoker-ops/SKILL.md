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

## Safe command map

### List workflows

```bash
./run.sh --headless query workflows --output text
./run.sh --headless query workflows --status failed --output json
```

### List tasks

```bash
./run.sh --headless query tasks --workflow <workflowId> --output text
./run.sh --headless query tasks --workflow <workflowId> --status pending --output json
./run.sh --headless query tasks --workflow <workflowId> --status failed --output json
./run.sh --headless query tasks --workflow <workflowId> --status running --output json
```

If the request says "all workflows", first list workflows, then query each workflow through `query tasks --workflow <workflowId>`.

### Retry failed tasks

```bash
./run.sh --headless retry-tasks --status failed --parallel 8
```

### Retry pending tasks

```bash
./run.sh --headless retry-tasks --status pending --parallel 8
```

### Dry-run a bulk retry

```bash
./run.sh --headless retry-tasks --status pending --parallel 8 --dry-run
```

### Retry one task

```bash
./run.sh --headless retry-task <taskId> --no-track
```

### Retry one workflow

```bash
./run.sh --headless retry <workflowId> --no-track
```

## Acknowledgement boundary

Bulk retry commands must use `--no-track`.

The operator acknowledgement means the retry request was accepted for dispatch. It does not mean the task finished.

After submitting, verify with query commands, not database reads.

## Workflow for "retry/restart all failed or pending tasks"

1. Run a dry-run if the request is broad or destructive-looking.
2. Run `./run.sh --headless retry-tasks --status <status> --parallel 8`.
3. Report accepted and failed submission counts from command output.
4. Verify remaining tasks with `query tasks` commands when the user asks for current state.

## If a command is missing

Do not invent SQL as the fallback.

Report the missing command surface and add/fix the command if the user asked for a durable production-safe path.
