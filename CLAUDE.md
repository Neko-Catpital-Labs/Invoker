# Invoker Project Instructions

## Planning Rules

- Every step in a plan MUST be testable. Each implementation step must have a corresponding verification with a concrete, executable command that produces a clear pass/fail exit code (e.g. `pnpm test`, `git diff --name-only`). Do not use AI prompts for test tasks — use commands only.
- Bug fix plans MUST follow a three-phase approach before any implementation:
  1. **Reproduce** -- Find or write a concrete reproduction case (a failing test or a command that demonstrates the bug). Report back the exact repro steps and observed vs. expected behavior. Do not proceed until the bug is reliably reproducible.
  2. **Debug and report** -- Investigate and report: (a) the root cause — why the code is in the buggy state, and (b) the test gap — how the bug escaped existing tests (missing coverage, wrong assumptions, untested edge case, etc.).
  3. **Plan the fix** -- Only after completing steps 1 and 2, create the implementation plan. The plan must include a verification step that re-runs the reproduction case to confirm the fix.

## Testing Architecture

All packages use standard `vitest run` via `pnpm test`. The persistence layer uses `sql.js` (WASM-based SQLite), so tests run under system Node with no native SQLite addon or Electron test runtime.

### How it works

- Every package's `package.json` has `"test": "vitest run"`.
- Root `pnpm test` runs packages **one at a time** (`pnpm -r --workspace-concurrency=1`) so constrained machines stay responsive; `pnpm run test:high-resource` uses parallel package runs.

### In plan tasks

**ALWAYS use `pnpm test` in plan task commands, NEVER use `npx vitest run` or direct vitest calls.**

```yaml
# Wrong — vitest may not be in PATH:
command: "cd packages/surfaces && npx vitest run"
command: "cd packages/surfaces && vitest run"

# Right — uses package.json test script:
command: "cd packages/surfaces && pnpm test"
```

### Worktree provisioning

Git worktrees created by `WorktreeFamiliar` run `pnpm install --frozen-lockfile` to provision dependencies. No rebuild step needed.

Verify worktree provisioning end-to-end:

```bash
bash scripts/test-worktree-provisioning.sh
```

### Familiar tests and git safety

Tests that create real `WorktreeFamiliar`/`DockerFamiliar` and call `.start()` run real git via `BaseFamiliar.execGitSimple()`. To prevent repo mutation:

1. **Mock git lifecycle** (for tests that don't need real git): spy on `execGitSimple`, `syncFromRemote`, `setupTaskBranch`, `recordTaskResult`, `restoreBranch`, `pushBranchToRemote`. See spies in `open-terminal.test.ts` or integration tests that mock `BaseFamiliar.prototype.execGitSimple`.
2. **Use a sandbox repo** (for tests that validate git behavior): `mkdtempSync` + `git init`. See `auto-commit.test.ts`, `branch-chain.test.ts`.

## File Editing Discipline

After making a change with any edit tool, **read the file back from disk** (using the Read tool or `rg` in the Shell) and verify the edit persisted before proceeding. Cursor's in-memory state can silently revert writes. If the change is missing on disk, re-apply it using the Shell tool (e.g. `python3 -c "..."` or `sed`) and verify again. When committing, always `git diff --stat` immediately before `git add` to confirm the working tree contains the expected modifications.

## Code Navigation

Use LSP tools (`goToDefinition`, `findReferences`, `documentSymbol`, `workspaceSymbol`, `incomingCalls`, `outgoingCalls`, `hover`) for any task involving symbols, types, or cross-file relationships. Use Grep and Glob for literal text searches and file discovery.
