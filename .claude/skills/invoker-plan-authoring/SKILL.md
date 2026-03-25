---
name: invoker-plan-authoring
description: Author YAML task plans for the Invoker orchestrator. Use when the user wants to create, write, or modify an Invoker plan, generate a task YAML, or asks about plan format, task dependencies, familiar types, or plan execution.
---

# Invoker Plan Authoring

## Overview

Invoker is a task orchestrator that executes YAML plans as a directed acyclic graph (DAG) of parallel tasks. Each task is either a shell command or an AI prompt. Tasks run in isolated git worktrees (or other execution environments) and results merge back automatically.

## Workflow: Author → Write → Submit

When the user asks you to create and run a plan, follow these three steps:

### Step 1: Author the YAML plan
Use the reference below to write a valid YAML plan. Explore the codebase first to reference real files and test paths.

### Step 2: Write the plan to a file
Write the YAML to `/tmp/plan-<slug>.yaml` where `<slug>` is derived from the plan name:
```
/tmp/plan-add-date-formatter.yaml
```

### Step 3: Submit to Invoker
Run the submission script from the invoker repo root:
```bash
cd ~/Desktop/Github/invoker-v2 && ./submit-plan.sh /tmp/plan-<slug>.yaml
```

This launches Invoker in headless mode via Electron. The script resolves absolute paths, unsets `ELECTRON_RUN_AS_NODE`, and executes the plan.

**Important**: The invoker app must be built before submitting. If submission fails with a missing `dist/main.js`, run `./run.sh` first (which builds all packages) or `cd packages/app && pnpm build`.

### One-shot example
```bash
# Write plan, then submit
cat > /tmp/plan-verify-tests.yaml << 'EOF'
name: "Verify test suite"
onFinish: none
tasks:
  - id: check-core
    description: "Run core tests"
    command: "cd packages/core && pnpm test 2>&1"
    dependencies: []
EOF

cd ~/Desktop/Github/invoker-v2 && ./submit-plan.sh /tmp/plan-verify-tests.yaml
```

---

## Quick Start

Minimal valid plan template:

```yaml
name: "My Feature Plan"
description: |               # Recommended for pull_request plans
  Adds X to improve Y.
  Architecture: uses Z pattern for isolation.
  Tradeoffs: polling vs push events.
visualProof: false           # set true when modifying packages/ui/
onFinish: merge              # merge (default), none, or pull_request
baseBranch: master           # base git branch
featureBranch: plan/my-feature  # auto-generated from name if omitted
mergeMode: manual            # manual (default) or automatic
familiarType: worktree       # worktree (default), local, or docker
tasks:
  - id: implement-feature
    description: "Add the new feature"
    prompt: "Implement feature X by modifying file Y"
    dependencies: []

  - id: test-feature
    description: "Verify the feature works"
    command: "cd packages/mypackage && pnpm test"
    dependencies: ["implement-feature"]
```

## Plan Structure

### Plan-Level Fields

- **name** (required, string): Human-readable plan name
- **description** (optional, string): Multi-paragraph PR body text — architecture, motivations, tradeoffs. **Strongly recommended when `onFinish` is `pull_request`.** Without this, the PR body will only contain auto-generated task breakdowns with no context.
- **visualProof** (optional, boolean, default: false): Set true when plan modifies UI packages. Triggers automatic before/after screenshot and video capture during the merge gate.
- **onFinish** (optional, default: `merge`): Post-completion action
  - `merge`: merges feature branch into base branch
  - `pull_request`: creates a GitHub pull request
  - `none`: no action (useful for verification-only plans)
- **baseBranch** (optional): Base git branch. Auto-detected from repo if omitted.
- **featureBranch** (optional): Feature branch name. Auto-generated as `plan/<slug>` if omitted.
- **mergeMode** (optional, default: `manual`): Merge gate behavior
  - `manual`: waits for human approval before merging
  - `automatic`: merges without approval
- **familiarType** (optional, default: `worktree`): Execution environment for all tasks (can be overridden per-task)
  - `worktree`: isolated git worktree per task
  - `local`: runs in main repo directory
  - `docker`: runs in Docker container

### Task-Level Fields

- **id** (required, string): Unique task identifier in kebab-case (e.g., `implement-auth`)
- **description** (required, string): Human-readable task description
- **command** (optional, string): Shell command to execute (mutually exclusive with `prompt`)
- **prompt** (optional, string): AI instructions for implementation (mutually exclusive with `command`)
- **dependencies** (required, array): List of task IDs this task depends on. Always include, even if empty `[]`.
- **familiarType** (optional): Override plan-level execution environment for this task
- **autoFix** (optional, boolean, default: false): On failure, automatically spawn experimental fix variants
- **maxFixAttempts** (optional, number, default: 3): Max autofix attempts when `autoFix: true`
- **pivot** (optional, boolean, default: false): Try multiple approaches in parallel
- **experimentVariants** (optional, array): Variants to try when `pivot: true`. Each has `{id, description, prompt?, command?}`
- **requiresManualApproval** (optional, boolean, default: false): Pause for human approval before task completes
- **utilization** (optional, number or "max"): Resource budget (0-100 or "max") for scheduling control

**Rule**: A task MUST have either `command` OR `prompt`, NEVER both.

## Task Types

### Command Tasks

Shell commands executed as `/bin/sh -c "<command>"`. Exit code 0 indicates success.

Example:
```yaml
- id: run-tests
  description: "Run unit tests"
  command: "cd packages/core && pnpm test"
  dependencies: []
```

### Prompt Tasks

AI instructions for implementation work. The AI agent receives the prompt and executes it.

Example:
```yaml
- id: add-feature
  description: "Implement user authentication"
  prompt: |
    Add user authentication to the app:
    1. Create a new Auth service
    2. Add login/logout endpoints
    3. Update the UI with login form
  dependencies: []
```

## Dependencies and Execution

- Tasks form a DAG. A task is ready when all its dependencies have completed successfully.
- Independent tasks run in parallel. Default max concurrency: 3.
- Always include the `dependencies` field, even if it's an empty array `[]`.
- Use meaningful kebab-case task IDs (e.g., `test-auth-service`, not `task1`).

Example dependency chain:
```yaml
tasks:
  - id: create-schema
    description: "Create database schema"
    command: "psql -f schema.sql"
    dependencies: []

  - id: seed-data
    description: "Seed test data"
    command: "psql -f seed.sql"
    dependencies: ["create-schema"]

  - id: run-migration-tests
    description: "Verify migration works"
    command: "cd packages/db && pnpm test"
    dependencies: ["seed-data"]
```

## Testing Rules (CRITICAL)

**Every implementation (prompt) task MUST have a corresponding verification command task.**

### Verification must be functional, not structural

Syntax checks (`node --check`, `bash -n`, `grep -q`) are NOT sufficient verification. They prove the code parses — not that it works. Every verification task must **execute the actual behavior** and check for correct output.

Ask: "If this verification passes, am I confident the feature works?" If the answer is no, the verification is too weak.

#### Verification strength ladder

1. **Structural** (INSUFFICIENT alone): `node --check`, `bash -n`, `grep -q 'pattern'` — proves syntax, not behavior
2. **Import/load** (INSUFFICIENT alone): `node -e "require('./module')"` — proves dependencies resolve, not that code runs
3. **Smoke test** (MINIMUM required): Actually invoke the script/function with real or mock inputs and check output
4. **Existing test suite**: `cd packages/<pkg> && pnpm test` — best when the package already has tests covering the change
5. **Functional end-to-end**: Run the full workflow with real dependencies (APIs, files, etc.)

**Every verification task must be at level 3 or higher.** Levels 1-2 may be included as additional quick checks but never as the sole verification.

#### New scripts and tools

When a plan creates a new standalone script (not part of an existing package with tests), the verification task must:
- Actually run the script with valid inputs (real or mock)
- Check that output matches expected format
- Verify external dependencies are importable at runtime (not just installed)

Example — a script that uploads images:
```yaml
# WRONG: structural check only
- id: verify-upload
  command: "node --check scripts/upload.mjs && echo 'OK'"
  dependencies: ["implement-upload"]

# RIGHT: functional smoke test with --dry-run or mock mode
- id: verify-upload
  command: "node scripts/upload.mjs --dry-run --repo-id 12345 --images test-fixtures/sample.png 2>&1 | grep -q 'Upload complete' && echo 'OK'"
  dependencies: ["implement-upload"]

# RIGHT: if no dry-run mode, at least verify imports resolve and help text works
- id: verify-upload
  command: "node scripts/upload.mjs --help 2>&1 | grep -q 'Usage' && node -e \"import('./scripts/upload.mjs')\" 2>&1 && echo 'OK'"
  dependencies: ["implement-upload"]
```

#### New npm dependencies

When a plan installs a new npm package, verify it's importable at runtime — not just that `pnpm add` succeeded:
```yaml
# WRONG: only checks install exit code
- id: install-dep
  command: "pnpm add -Dw some-package 2>&1"

# RIGHT: install + verify importable
- id: install-dep
  command: "pnpm add -Dw some-package 2>&1 && node -e \"require('some-package')\" && echo 'Import OK'"
```

For ESM-only packages, use dynamic import:
```yaml
- id: install-dep
  command: "pnpm add -Dw some-esm-package 2>&1 && node -e \"import('some-esm-package').then(() => console.log('Import OK'))\" && echo 'Done'"
```

### Test Command Format

- **ALWAYS cd into the package directory**: `cd packages/<pkg> && pnpm test`
- To target a specific test file: `cd packages/<pkg> && pnpm test -- src/__tests__/file.test.ts`
- **NEVER run `pnpm test <path>` from the repo root** — it runs `pnpm -r test` across all packages
- **NEVER use `npx vitest run` or direct vitest calls** — always use `pnpm test` which runs the package.json test script
- **NEVER invent test file names** — verify the test file exists before referencing it
- **Do not use AI prompts for test/verification tasks** — use commands only

### Correct Examples

```yaml
# Good: cd into package first
- id: test-auth
  description: "Run auth service tests"
  command: "cd packages/auth && pnpm test"
  dependencies: ["implement-auth"]

# Good: target specific test file
- id: test-user-model
  description: "Verify user model tests pass"
  command: "cd packages/models && pnpm test -- src/__tests__/user.test.ts"
  dependencies: ["update-user-model"]
```

### Incorrect Examples

```yaml
# Wrong: running from repo root
- id: test-auth
  command: "pnpm test packages/auth"
  dependencies: ["implement-auth"]

# Wrong: using npx vitest directly
- id: test-auth
  command: "cd packages/auth && npx vitest run"
  dependencies: ["implement-auth"]

# Wrong: inventing test file that doesn't exist
- id: test-auth
  command: "cd packages/auth && pnpm test -- src/__tests__/auth-new-feature.test.ts"
  dependencies: ["implement-auth"]

# Wrong: using prompt for verification
- id: test-auth
  prompt: "Run the tests and verify they pass"
  dependencies: ["implement-auth"]

# Wrong: syntax-only check for a new script
- id: verify-script
  command: "node --check scripts/my-tool.mjs && echo 'OK'"
  dependencies: ["implement-script"]
```

## Familiar Types (Execution Environments)

Tasks run in different execution environments called "familiar types":

### worktree (default)

Each task gets its own isolated git worktree. Changes merge back automatically when the task completes. Use for most implementation work.

```yaml
- id: implement-feature
  description: "Add feature X"
  familiarType: worktree
  prompt: "Implement feature X"
  dependencies: []
```

### local

Runs in the main repo directory. Use for tasks that need access to the live working tree (e.g., running formatters, checking uncommitted changes).

```yaml
- id: format-code
  description: "Format all source files"
  familiarType: local
  command: "pnpm format"
  dependencies: []
```

### docker

Runs in a Docker container. Use for isolated/sandboxed execution or tasks requiring specific OS environments.

```yaml
- id: test-in-container
  description: "Run integration tests in Docker"
  familiarType: docker
  command: "pytest tests/integration/"
  dependencies: []
```

**Set at plan level (applies to all tasks) or per-task (overrides plan level).**

## Completion Behavior (onFinish)

Controls what happens after all tasks complete successfully:

- **merge** (default): Merges the feature branch into the base branch. With `mergeMode: manual`, waits for human approval at the merge gate.
- **pull_request**: Creates a GitHub pull request instead of merging directly.
- **none**: No post-completion action. Useful for verification-only plans or when you want to review before merging.

Example:
```yaml
name: "Verification Plan"
onFinish: none  # Don't merge, just verify
tasks:
  - id: check-types
    description: "TypeScript type check"
    command: "pnpm typecheck"
    dependencies: []
```

## Advanced Features

### autoFix + maxFixAttempts

When a task fails, automatically spawn experimental fix variants (conservative, refactor, alternative approaches).

```yaml
- id: implement-complex-feature
  description: "Add complex feature"
  prompt: "Implement feature X"
  autoFix: true
  maxFixAttempts: 3
  dependencies: []
```

Default `maxFixAttempts: 3` if `autoFix: true`.

### pivot + experimentVariants

Try multiple approaches in parallel. Define variants as an array of `{id, description, prompt?, command?}`.

```yaml
- id: optimize-query
  description: "Try different query optimization strategies"
  pivot: true
  experimentVariants:
    - id: caching
      description: "Use Redis caching"
      prompt: "Add Redis caching to the query layer"
    - id: indexing
      description: "Add database indexes"
      prompt: "Add appropriate database indexes"
    - id: materialized-view
      description: "Use materialized view"
      prompt: "Create a materialized view for this query"
  dependencies: []
```

### requiresManualApproval

Pause execution for human approval before the task completes. Useful for destructive operations or production changes.

```yaml
- id: deploy-production
  description: "Deploy to production"
  command: "./deploy.sh production"
  requiresManualApproval: true
  dependencies: ["run-all-tests"]
```

### utilization

Resource budget for scheduling control. Value from 0-100 or "max". Tasks with higher utilization may run with fewer concurrent tasks.

```yaml
- id: heavy-build
  description: "Build entire project"
  command: "pnpm build"
  utilization: 80
  dependencies: []
```

## Common Mistakes

- **Syntax-only verification for new scripts**: `node --check` and `bash -n` prove syntax, not behavior. Verification must actually run the code with inputs and check output. See "Verification strength ladder" above.
- **Not verifying new npm dependencies are importable**: `pnpm add` succeeding doesn't mean the package resolves at runtime. Add `node -e "require('pkg')"` or `node -e "import('pkg')"` to the install command.
- **Using `npx vitest run` instead of `pnpm test`**: Always use `pnpm test` to run the package.json test script.
- **Running `pnpm test packages/...` from the repo root**: Always cd into the package first.
- **Putting both `command` and `prompt` on a single task**: A task must have one or the other, never both.
- **Omitting the `dependencies` array**: Always include it, even if empty `[]`.
- **Including dangerous commands**: Avoid `rm -rf`, `git push --force`, `git reset --hard`, etc. without explicit user approval.
- **Making plans too large**: Aim for 3-8 tasks. Break large plans into multiple smaller plans.
- **Not having verification command tasks for implementation prompt tasks**: Every prompt task needs a corresponding test command task.
- **Inventing test file names that don't exist**: Always verify test files exist before referencing them.
- **Using prompts for verification**: Test tasks must use `command`, not `prompt`.
- **Omitting `description` on `pull_request` or `merge` plans**: The validator will **reject** these plans. Always include 1-3 paragraphs: architecture, motivations, tradeoffs.
- **Forgetting `visualProof: true` for UI changes**: Plans modifying `packages/ui/` should set `visualProof: true` at the plan level so the merge gate captures before/after screenshots.

## Additional Resources

For complete schema details, see [reference.md](reference.md).
For annotated examples, see [examples.md](examples.md).
