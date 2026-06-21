# First Agent Workflow Tutorial

This guide walks through a small Invoker workflow on a toy Node.js project. It is meant to answer the first onboarding question: "what do I click, what runs, and how would I adapt this to my own repo?"

The workflow uses an agent task to fix a failing test, then a command task to verify the fix.

## What you will run

The tutorial creates a temporary git repo with this shape:

```text
package.json
src/greeter.js
test/greeter.test.js
invoker-plans/
  first-agent-workflow-codex.yaml
  first-agent-workflow-claude.yaml
```

The starting implementation is intentionally wrong. The tests expect `Hello, Ada!`, but the implementation returns `Hello Ada`.

## Before you start

Install Invoker and build it from the repo root:

```bash
pnpm install
bash scripts/setup-agent-skills.sh
pnpm run build
```

For your own changes, install helpers from System Setup or `invoker-ui --install-skills`, then run `/invoker-plan-to-invoker "help me plan <change>"` in Codex, Claude, Cursor, or OMP. The command plans first, writes `plans/invoker-handoff.md`, converts it to YAML, validates, and submits with `invoker-cli run --live` or the Invoker MCP tool.

Make sure at least one supported agent CLI is installed and authenticated:

```bash
codex --version
# or
claude --version
```

If you launch the desktop app from Finder on macOS, it may not inherit your terminal `PATH`. For this tutorial, start Invoker from the terminal so it can find `node`, `npm`, `git`, and your agent CLI.

## Create the toy project

From the Invoker repo root, run:

```bash
examples/first-agent-workflow/create-local-project.sh
```

The script prints the generated project path and two plan paths. By default, the project is created at:

```text
/tmp/invoker-first-agent-workflow
```

Confirm the initial test failure:

```bash
cd /tmp/invoker-first-agent-workflow
npm test
```

You should see a failing `node --test` run. That failure is the work the agent will fix.

## Open the plan

Start the desktop app from the Invoker repo root:

```bash
./run.sh
```

In the left rail, click `Open`.

Choose one generated plan:

```text
/tmp/invoker-first-agent-workflow/invoker-plans/first-agent-workflow-codex.yaml
```

or:

```text
/tmp/invoker-first-agent-workflow/invoker-plans/first-agent-workflow-claude.yaml
```

Checkpoint: the left rail should show the plan name, and a `Start` button should appear.

## Start the workflow

Click `Start`.

Checkpoint: the `Home` view should show one workflow node. Select it to open the workflow task DAG.

The DAG has two tasks:

- `fix-greeter`: an agent prompt task that edits the toy project.
- `verify`: a command task that runs `npm test` after `fix-greeter` completes.

Select `fix-greeter` to see details in the inspector. Its status should move through running states while the selected agent works in an isolated Invoker worktree.

After `fix-greeter` completes, `verify` should become runnable and then run `npm test`.

Checkpoint: when the workflow is done, both tasks should be `COMPLETED`.

## Inspect what happened

Use these views while or after the workflow runs:

- `Home`: workflow graph and selected workflow task DAG.
- `Timeline`: ordered lifecycle events.
- `History`: completed and previous task attempts.
- `Queue`: runnable/running task queue.
- `Action Graph`: lower-level action state for debugging.

Click a task in the DAG to inspect status, timing, command or prompt text, workspace metadata, and errors.

Double-click a task, or right-click it and choose `Open Terminal`, to open a terminal session for that task when a managed workspace is available.

## If something fails

If the agent task fails because the agent CLI is missing or unauthenticated, install or log in to the CLI, then retry the task or rerun the workflow.

If `verify` fails, select the failed task and read the inspector error. You can right-click the workflow and choose `Retry Workflow`, or right-click an individual failed task and choose a task action such as retry or open terminal.

If the desktop app cannot find `npm`, `node`, `git`, `codex`, or `claude`, quit it and restart with `./run.sh` from your terminal.

## Use the same pattern on your own repo

The generated YAML is intentionally small:

```yaml
name: First agent workflow (codex)
repoUrl: /tmp/invoker-first-agent-workflow
baseBranch: HEAD
onFinish: none
mergeMode: manual
tasks:
  - id: fix-greeter
    description: Fix the greeter implementation so the Node test suite passes.
    prompt: |
      You are working in a small Node.js project.
      Make the existing test suite pass.
    executionAgent: codex
    dependencies: []

  - id: verify
    description: Run the test suite after the agent fix.
    command: npm test
    dependencies: [fix-greeter]
```

To adapt it:

- Change `repoUrl` to your repo URL or local repo path.
- Change `baseBranch` to your target branch, such as `main`.
- Replace the prompt with the concrete change you want.
- Replace `npm test` with your real verification command.
- Use `executionAgent: codex` or `executionAgent: claude`, depending on the agent you want.

Keep `onFinish: none` while learning. Once you want Invoker to converge branches into review or merge flow, use a remote-backed repo and switch to `onFinish: pull_request` or `onFinish: merge` with an appropriate merge mode.

## Why this exists

Invoker has architecture and reference docs, but a first-time user needs a procedural path before they need the internals. This tutorial is that path: create a repo, open a plan, start a workflow, inspect the graph, and map the same workflow shape back to a real project.
