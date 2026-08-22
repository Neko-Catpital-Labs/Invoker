# First Agent Workflow Tutorial

This guide runs a small Invoker workflow against a generated Node.js repository. It covers the current desktop flow: bind a repository, draft and review a plan, create a staged workflow, then start it explicitly.

## What you will run

The example generator creates a temporary git repository containing:

```text
package.json
src/greeter.js
test/greeter.test.js
invoker-plans/
  first-agent-workflow-codex.yaml
  first-agent-workflow-claude.yaml
```

The implementation returns `Hello Ada`, while the tests require `Hello, Ada!`. An agent task fixes the implementation and a command task verifies it.

## Before you start

Install dependencies and build Invoker from the repository root:

```bash
pnpm install
bash scripts/setup-agent-skills.sh
pnpm run build
```

Make sure Codex or Claude is installed and authenticated:

```bash
codex --version
# or
claude --version
```

If you launch the desktop app from Finder on macOS, it may not inherit your terminal `PATH`. Start Invoker from the terminal for this tutorial.

## Create the toy project

From the Invoker repository root, run:

```bash
examples/first-agent-workflow/create-local-project.sh
```

The script prints the generated project path. On macOS it will normally be under `$TMPDIR`, for example:

```text
/var/folders/.../T/invoker-first-agent-workflow
```

Do not assume the path is `/tmp`; use the exact path printed by the script.

Confirm the starting failure:

```bash
cd <generated-project-path>
npm test
```

Both tests should fail because the greeting punctuation is missing.

## Bind the repository

The desktop planner does not currently have a repository picker. Set the generated path as the default planning repository in `~/.invoker/config.json`, preserving any other settings already in that file:

```json
{
  "defaultRepoUrl": "<generated-project-path>",
  "defaultBranch": "main"
}
```

Restart Invoker after changing backend configuration. If you are developing Invoker itself, `pnpm dev:hot` hot reloads renderer changes, but backend and configuration changes still require restarting the command.

Create a new planning chat after restarting. Existing chats retain their original repository binding.

Checkpoint: the right sidebar's **Repo** section should show `invoker-first-agent-workflow`, not Invoker's own repository.

## Draft the workflow

In **Home**, ask the planner:

```text
Fix the failing greeting tests in this repository. Draft a workflow with an agent task that fixes the implementation and a dependent command task that runs npm test. Make sure you set onFinish: none, mergeMode: automatic, and baseBranch: main. Do not create a pull request.
```

The planner should use the repository shown in the sidebar. If it silently generates a different `repoUrl`, Invoker rejects that draft and asks the planner to correct it automatically.

When the draft is ready, click **Review draft**. The review sidebar renders task descriptions as Markdown; use **Raw YAML** to inspect the complete plan.

Verify these top-level values before continuing:

```yaml
repoUrl: <generated-project-path>
baseBranch: main
onFinish: none
mergeMode: automatic
```

`automatic` plus `none` lets this local-only tutorial finish as completed. `manual` plus `none` intentionally stops at `review_ready` for human inspection and has no merge action.

## Create and review the workflow

Click **Create workflow**.

This loads the workflow in a staged state. It does not start tasks.

Click **Open graph** and select the workflow node. The task DAG should show the implementation and verification tasks as pending. You can inspect their prompts, commands, dependencies, and repository metadata before execution.

Checkpoint: no task should be running yet, and the Home message should say to review the graph and then use **Start ready work**.

## Start ready work

Click **Start ready work** and confirm the action.

Invoker activates the staged workflow and runs its ready tasks:

- The agent task edits the greeter in an isolated worktree.
- The verification task runs `npm test` after the agent task completes.
- With `mergeMode: automatic` and `onFinish: none`, the workflow gate completes without requiring a merge or pull request action for you to approve.

Checkpoint: the workflow graph should finish green.

## Inspect what happened

Use these views while or after the workflow runs:

- **Home**: planning chat and selected workflow graph.
- **Workflows**: submitted workflows and their task DAGs.
- **Timeline**: ordered lifecycle events.
- **History**: completed and previous task attempts.
- **Queue**: runnable and running tasks.
- **Action Graph**: lower-level action state for debugging.

Click a task in the DAG to inspect status, timing, command or prompt text, workspace metadata, output, and errors.

Double-click a task, or use its context menu, to open a managed terminal when a workspace is available.

## Generated YAML plans

The generator also writes Codex and Claude YAML plans under `invoker-plans/`. They are useful as small reference plans or for testing the CLI.

The desktop app does not currently import plan files. Running a generated file through the CLI submits and starts it immediately. The reference files use `mergeMode: manual`, so they intentionally stop at `review_ready` after their tasks pass:

```bash
invoker-cli run <generated-project-path>/invoker-plans/first-agent-workflow-codex.yaml --live
```

Use the in-app planning flow above when you want to review the graph before starting work.

## If something fails

- If the temporary repository no longer exists, rerun the generator. Operating-system cleanup may remove `$TMPDIR` contents.
- If the Repo sidebar shows the wrong repository, update `~/.invoker/config.json`, restart Invoker, and create a new planning chat.
- If Codex reports an expired refresh token, run `codex logout`, then `codex login`, and retry.
- If a plan targets GitHub unexpectedly, check its `repoUrl` in Raw YAML before creating the workflow.
- For a local repository, keep `onFinish: none`; `pull_request` requires a parseable GitHub remote and push permissions.
- If the app cannot find `npm`, `node`, `git`, `codex`, or `claude`, restart it from a terminal.

## Adapt the pattern

For another repository:

- Bind the intended repository and branch before starting a new planning chat.
- Give the agent one concrete implementation task.
- Add deterministic command tasks for verification.
- Use `onFinish: none` while learning or when no remote publication is required.
- Use `mergeMode: automatic` for unattended completion, or `manual` when `review_ready` is the desired terminal review state.
- Use `onFinish: pull_request` or `merge` only with a remote-backed repository and appropriate credentials.
