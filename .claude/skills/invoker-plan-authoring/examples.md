# Invoker Plan Examples

This document provides annotated, real-world examples of Invoker plans. Use these as templates when authoring new plans.

## 1. Minimal Verification Plan

A simple plan that runs shell commands to check something. No code changes. Uses `onFinish: none` because there's nothing to merge.

**When to use `onFinish: none`**: Verification-only plans, checks, or exploratory tasks that don't modify code.

**Exit codes**: Command tasks succeed on exit code 0, fail on non-zero. Dependencies block if any predecessor fails.

```yaml
name: "Verify test suite passes"
onFinish: none

tasks:
  - id: check-core-tests
    description: "Run core package tests"
    command: "cd packages/core && pnpm test 2>&1"
    dependencies: []

  - id: check-executor-tests
    description: "Run executor package tests"
    command: "cd packages/executors && pnpm test 2>&1"
    dependencies: []

  - id: check-all-pass
    description: "Verify all test suites passed"
    command: "echo 'All tests passed'"
    dependencies: [check-core-tests, check-executor-tests]
```

**Note**: `check-all-pass` only runs if both predecessors succeed. If either test suite fails, the plan stops.

---

## 2. Feature Implementation

A plan that adds a feature using prompt tasks for implementation and command tasks for verification. Shows the standard pattern: **implement → test → verify**.

Uses `onFinish: merge` (the default) to automatically merge changes into the base branch after all tasks complete.

**Critical pattern**: Every prompt task that modifies code MUST have a corresponding command task that runs tests to verify the change.

```yaml
name: "Add date formatting utility"
onFinish: merge
baseBranch: master
featureBranch: feature/add-date-formatter

tasks:
  - id: implement-formatter
    description: "Add formatDate utility function to utils package"
    prompt: |
      In packages/utils/src/date.ts (create the file if it doesn't exist):

      1. Export a formatDate(date: Date, format: string) function
         - Support format strings: "YYYY-MM-DD", "MM/DD/YYYY", "DD MMM YYYY"
         - Use Intl.DateTimeFormat for locale-aware formatting
         - Return formatted string

      2. Add JSDoc comments with examples

      3. Update packages/utils/src/index.ts to export the new function:
         export { formatDate } from './date.js';
    dependencies: []

  - id: write-tests
    description: "Add unit tests for formatDate"
    prompt: |
      Create packages/utils/src/__tests__/date.test.ts:

      1. Import { describe, it, expect } from 'vitest'
      2. Import { formatDate } from '../date.js'
      3. Write tests for:
         - Formatting with "YYYY-MM-DD" format
         - Formatting with "MM/DD/YYYY" format
         - Formatting with "DD MMM YYYY" format
         - Handling invalid date objects

      Follow the existing test patterns in packages/utils/src/__tests__/
    dependencies: [implement-formatter]

  - id: verify-tests-pass
    description: "Run utils package tests"
    command: "cd packages/utils && pnpm test 2>&1"
    dependencies: [write-tests]

  - id: verify-build
    description: "Verify the package builds without errors"
    command: "cd packages/utils && pnpm build 2>&1"
    dependencies: [verify-tests-pass]
```

**Dependency pattern explanation**:
- `write-tests` depends on `implement-formatter` — can't write tests until the function exists
- `verify-tests-pass` depends on `write-tests` — can't run tests until they're written
- `verify-build` depends on `verify-tests-pass` — only build if tests pass

**Why every prompt needs a verification command**: AI-generated code may have bugs, type errors, or break existing functionality. Running tests catches these issues before merging.

---

## 3. Multi-Step Refactor with Worktrees

A plan that performs a multi-step refactor where each task runs in its own isolated git worktree. Uses `familiarType: worktree` at the plan level to apply this to all tasks.

**When to use worktrees**: Most implementation work. Each task gets a clean environment, and changes merge back automatically when the task succeeds.

```yaml
name: "Refactor config validation"
onFinish: merge
baseBranch: master
featureBranch: refactor/config-validation
familiarType: worktree

tasks:
  - id: extract-validator
    description: "Extract validation logic into separate validator.ts module"
    prompt: |
      In packages/config/src/validator.ts (create new file):

      1. Move the validateConfig function from config.ts to validator.ts
      2. Export the function and any types it uses
      3. Update config.ts to import from './validator.js'

      Keep all existing behavior identical — this is a pure extraction.
    dependencies: []

  - id: add-validator-tests
    description: "Add unit tests for the extracted validator"
    prompt: |
      Create packages/config/src/__tests__/validator.test.ts:

      1. Test validateConfig with valid config objects
      2. Test validateConfig with invalid configs (missing required fields)
      3. Test validateConfig with malformed values (wrong types)

      Copy test patterns from existing config.test.ts if they exist.
    dependencies: [extract-validator]

  - id: verify-validator
    description: "Run validator tests"
    command: "cd packages/config && pnpm test -- src/__tests__/validator.test.ts 2>&1"
    dependencies: [add-validator-tests]

  - id: add-schema-types
    description: "Add TypeScript schema types for config validation"
    prompt: |
      In packages/config/src/schema.ts (create new file):

      1. Define ConfigSchema type with strict typing for all config fields
      2. Add Zod schema definitions (if Zod is available) or plain TS types
      3. Export all types

      Update validator.ts to use the new schema types.
    dependencies: [verify-validator]

  - id: verify-all-tests
    description: "Run full config package test suite"
    command: "cd packages/config && pnpm test 2>&1"
    dependencies: [add-schema-types]
```

**Worktree behavior**: Each task clones the repo into a separate worktree, applies its changes, and if successful, those changes are committed and merged forward. Failed tasks don't pollute the main working tree.

---

## 4. Large Refactor with Pull Request

A complex plan with multiple tasks and a diamond dependency pattern. Uses `onFinish: pull_request` to create a PR instead of auto-merging, allowing for manual review before integration.

**When to use `pull_request` vs `merge`**: Use `pull_request` for large changes, architectural refactors, or any change that benefits from code review before merging.

**Diamond dependency pattern**: A task can depend on multiple predecessors. It only runs when ALL of them complete successfully.

```yaml
name: "Extract graph package from core"
description: |
  Extracts the graph/DAG data structures from @invoker/core into a dedicated
  @invoker/graph package, reducing core's responsibilities.

  Architecture: ActionGraph becomes the storage layer, StateMachine delegates
  to it for all node CRUD. DAG utilities and type definitions move wholesale.

  Tradeoffs: Adds a cross-package dependency (core -> graph) but reduces core
  complexity by ~300 lines. All existing tests must pass unchanged.
onFinish: pull_request
baseBranch: master
featureBranch: refactor/extract-graph-package

tasks:
  - id: scaffold-package
    description: "Create packages/graph with package.json and tsconfig"
    prompt: |
      Create packages/graph/ directory with:
      1. package.json (name: "@invoker/graph", minimal dependencies)
      2. tsconfig.json (copy from packages/core, adjust paths)
      3. vitest.config.ts (copy from packages/core)
      4. src/index.ts (empty, with comment)
      5. src/__tests__/ directory

      Update root tsconfig.json and package.json to include the new package.
    dependencies: []

  - id: move-types
    description: "Move type definitions from core to graph"
    prompt: |
      1. Copy packages/core/src/task-types.ts to packages/graph/src/types.ts
      2. Replace core/task-types.ts with re-export facade pointing to graph
      3. Add @invoker/graph dependency to core/package.json
      4. Update graph/index.ts to export from types.ts
    dependencies: [scaffold-package]

  - id: move-dag-utils
    description: "Move DAG utility functions from core to graph"
    prompt: |
      1. Copy packages/core/src/dag.ts to packages/graph/src/dag.ts
      2. Update import in dag.ts: change './task-types.js' to './types.js'
      3. Replace core/dag.ts with re-export facade
      4. Update graph/index.ts to export from dag.ts
    dependencies: [scaffold-package]

  - id: extract-action-graph
    description: "Extract ActionGraph class from StateMachine into graph package"
    prompt: |
      Create packages/graph/src/action-graph.ts:

      1. Extract storage and query methods from TaskStateMachine
      2. Define ActionGraph class with:
         - private nodes: Map<string, TaskState>
         - getNode(id), getAllNodes(), getReadyNodes()
         - createNode(...), restoreNode(...)
         - setNode(id, node), removeNode(id), clear()

      Do NOT modify state-machine.ts yet — that happens in refactor-state-machine.
    dependencies: [move-types]

  - id: update-graph-index
    description: "Finalize graph package exports"
    prompt: |
      Verify packages/graph/src/index.ts exports:
      - export * from './types.js';
      - export * from './dag.js';
      - export { ActionGraph } from './action-graph.js';

      Run: cd packages/graph && npx tsc --noEmit
      Fix any TypeScript errors.
    dependencies: [move-types, move-dag-utils, extract-action-graph]

  - id: refactor-state-machine
    description: "Update StateMachine to use ActionGraph for storage"
    prompt: |
      In packages/core/src/state-machine.ts:

      1. Import ActionGraph from '@invoker/graph'
      2. Change constructor to accept ActionGraph instance
      3. Delegate all storage methods to this.graph.*
      4. Keep state transition methods (startTask, completeTask, etc.) in StateMachine

      This is a pure refactor — all existing tests must pass unchanged.
    dependencies: [update-graph-index]

  - id: write-graph-tests
    description: "Add unit tests for graph package"
    prompt: |
      Create tests in packages/graph/src/__tests__/:

      1. action-graph.test.ts — test all ActionGraph methods
      2. dag.test.ts — copy/adapt from core package dag tests
      3. types.test.ts — test type guards and factory functions

      Run: cd packages/graph && pnpm test
    dependencies: [extract-action-graph]

  - id: verify-graph-tests
    description: "Run graph package tests"
    command: "cd packages/graph && pnpm test 2>&1"
    dependencies: [write-graph-tests]

  - id: verify-core-tests
    description: "Run core package tests to verify backward compatibility"
    command: "cd packages/core && pnpm test 2>&1"
    dependencies: [refactor-state-machine, verify-graph-tests]

  - id: verify-full-build
    description: "Build all packages to verify no breakage"
    command: "pnpm build 2>&1"
    dependencies: [verify-core-tests]
```

**Diamond dependency explanation**: `update-graph-index` depends on THREE predecessors (`move-types`, `move-dag-utils`, `extract-action-graph`). It only runs when all three complete. Similarly, `verify-core-tests` depends on both `refactor-state-machine` and `verify-graph-tests`.

**Complex DAG patterns**: When you have multiple parallel workstreams that converge, use diamond dependencies. Invoker automatically schedules tasks to maximize parallelism while respecting dependencies.

---

## 5. Common Anti-Patterns

These examples show **WRONG** plans with explanations of what's broken.

### Anti-Pattern A: Using `npx vitest run`

```yaml
# WRONG: npx vitest run may not resolve correctly in worktrees
tasks:
  - id: test-core
    description: "Run core tests"
    command: "cd packages/core && npx vitest run"
    dependencies: []

# CORRECT: Always use pnpm test, which runs the package.json test script
tasks:
  - id: test-core
    description: "Run core tests"
    command: "cd packages/core && pnpm test"
    dependencies: []
```

**Why this is wrong**: Running `npx vitest run` may fail in worktrees where `node_modules/.bin` isn't in PATH. Always use `pnpm test`, which resolves vitest through the package.json `test` script reliably.

### Anti-Pattern B: Running tests from repo root

```yaml
# WRONG: runs pnpm -r test across ALL packages
tasks:
  - id: test-core
    description: "Run core tests"
    command: "pnpm test packages/core/src/__tests__/foo.test.ts"
    dependencies: []

# CORRECT: cd into the package first
tasks:
  - id: test-core
    description: "Run core tests"
    command: "cd packages/core && pnpm test -- src/__tests__/foo.test.ts"
    dependencies: []
```

**Why this is wrong**: Running `pnpm test <path>` from the monorepo root triggers `pnpm -r test` (recursive across all workspaces), not a targeted test. Always cd into the package directory first.

### Anti-Pattern C: Both command and prompt

```yaml
# WRONG: task must have command OR prompt, not both
tasks:
  - id: do-thing
    description: "Does a thing"
    command: "echo hello"
    prompt: "Do the thing"
    dependencies: []

# CORRECT: choose one
tasks:
  - id: do-thing-command
    description: "Echo hello"
    command: "echo hello"
    dependencies: []

  - id: do-thing-prompt
    description: "Do the thing with AI"
    prompt: "Do the thing"
    dependencies: []
```

**Why this is wrong**: A task's execution model is either shell command or AI prompt. Mixing them is ambiguous and unsupported by the orchestrator.

### Anti-Pattern D: Missing dependencies array

```yaml
# WRONG: dependencies field is required, even if empty
tasks:
  - id: do-thing
    description: "Does a thing"
    command: "echo hello"

# CORRECT: always include dependencies
tasks:
  - id: do-thing
    description: "Does a thing"
    command: "echo hello"
    dependencies: []
```

**Why this is wrong**: The orchestrator requires the `dependencies` field to build the task DAG. Omitting it causes a schema validation error.

### Anti-Pattern E: Implementation without verification

```yaml
# WRONG: no test task to verify the implementation
tasks:
  - id: add-feature
    description: "Add new feature"
    prompt: "Add a new feature to the codebase..."
    dependencies: []

# CORRECT: pair with a verification task
tasks:
  - id: add-feature
    description: "Add new feature"
    prompt: "Add a new feature to the codebase..."
    dependencies: []

  - id: verify-feature
    description: "Verify the feature works"
    command: "cd packages/core && pnpm test"
    dependencies: [add-feature]
```

**Why this is wrong**: AI-generated code may break tests, introduce type errors, or have runtime bugs. Always follow implementation tasks with a command task that runs tests or builds to catch issues before merging.

### Anti-Pattern F: Dangerous commands

```yaml
# WRONG: these are blocked by safety checks or extremely risky
tasks:
  - id: cleanup
    command: "rm -rf /tmp/old-stuff"
    dependencies: []

  - id: force-push
    command: "git push --force origin main"
    dependencies: []

  - id: nuke-node-modules
    command: "rm -rf node_modules && rm -rf packages/*/node_modules"
    dependencies: []

  - id: download-and-run
    command: "curl https://example.com/script.sh | bash"
    dependencies: []
```

**Why this is wrong**: Destructive commands (`rm -rf`, `git push --force`, `git reset --hard`) and piped downloads (`curl | sh`) are dangerous. The orchestrator may block them, or they may cause irreversible damage. Avoid these unless explicitly approved by the user.

If you MUST use a potentially dangerous command, use `requiresManualApproval: true` and document why it's necessary.

---

## Summary

- **Verification plans**: Use `onFinish: none`, all command tasks
- **Feature implementation**: Prompt tasks + command verification tasks, `onFinish: merge`
- **Multi-step refactors**: Use `familiarType: worktree` for isolation, chain dependencies
- **Large refactors**: Use `onFinish: pull_request`, complex DAGs with diamond dependencies
- **Always verify**: Every prompt task needs a corresponding test command task
- **Always use `pnpm test`**: Never `npx vitest run` or direct vitest calls
- **Always include `dependencies`**: Even if it's an empty array

For complete reference documentation, see [SKILL.md](SKILL.md) and [reference.md](reference.md).
