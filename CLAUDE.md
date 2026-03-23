# Invoker Project Instructions

## Planning Rules

- Every step in a plan MUST be testable. Each implementation step must have a corresponding verification with a concrete, executable command that produces a clear pass/fail exit code (e.g. `pnpm test`, `git diff --name-only`). Do not use AI prompts for test tasks — use commands only.
- Bug fix plans MUST follow a three-phase approach before any implementation:
  1. **Reproduce** -- Find or write a concrete reproduction case (a failing test or a command that demonstrates the bug). Report back the exact repro steps and observed vs. expected behavior. Do not proceed until the bug is reliably reproducible.
  2. **Debug and report** -- Investigate and report: (a) the root cause — why the code is in the buggy state, and (b) the test gap — how the bug escaped existing tests (missing coverage, wrong assumptions, untested edge case, etc.).
  3. **Plan the fix** -- Only after completing steps 1 and 2, create the implementation plan. The plan must include a verification step that re-runs the reproduction case to confirm the fix.

## Testing Architecture

**ALL packages in this project use `../../scripts/electron-vitest run` for running tests.** This is the ONE CORRECT WAY to run tests, regardless of whether the package uses native modules or not.

### Why this approach

1. **Consistency**: Same test command works in main repo and worktrees
2. **No node_modules needed**: Script path is relative, works from any worktree
3. **ABI safety**: Handles native module ABI mismatches automatically
4. **Environment handling**: Correctly sets `ELECTRON_RUN_AS_NODE=1` for all tests

### How it works

- Every package's `package.json` has `"test": "../../scripts/electron-vitest run"`
- `electron-vitest` is a wrapper that sets `ELECTRON_RUN_AS_NODE=1` and runs vitest under Electron's Node.js
- This ensures `better-sqlite3` (compiled for Electron ABI 133) is loaded by the correct Node runtime
- Works for ALL packages, not just those with native dependencies

### In plan tasks

**ALWAYS use `pnpm test` in plan task commands, NEVER use `npx vitest run` or direct vitest calls.**

`WorktreeFamiliar` strips `ELECTRON_RUN_AS_NODE` from task subprocess environments by design. When you run `pnpm test`, the package.json script restores the correct environment via `electron-vitest`, bypassing this limitation.

```yaml
# Wrong — crashes with ABI mismatch or "vitest: not found":
command: "cd packages/surfaces && npx vitest run"
command: "cd packages/surfaces && vitest run"

# Right — uses electron-vitest, ABI matches:
command: "cd packages/surfaces && pnpm test"
```

## Native Module ABI

This project uses `better-sqlite3`, a native C++ addon that must be compiled for a specific Node.js ABI. Electron bundles its own Node.js with a **different ABI** than system Node, even when the major version matches:

| Runtime | ABI | Used by |
|---------|-----|---------|
| System Node v22 | 127 | scripts, packages without native deps |
| Electron 35 | 133 | app, E2E tests, headless mode |

**The project standardizes on Electron's ABI (133).** The binary is compiled once for Electron and all tests run under Electron's Node via `ELECTRON_RUN_AS_NODE=1`.

### How it works

- `pnpm install` triggers `postinstall` → `scripts/rebuild-for-electron.js`, which runs `scripts/check-native-modules.js` under Electron's Node (`ELECTRON_RUN_AS_NODE=1`) to compile `better-sqlite3` for ABI 133.
- `onlyBuiltDependencies` in root `package.json` allows both `better-sqlite3` (native compile) and `electron` (binary download) to run their install scripts.
- **ALL packages** run tests through `scripts/electron-vitest`, which executes vitest under Electron's bundled Node.js (ABI 133). This includes packages without native deps for consistency.
- All Electron entry points (`dev`, `run.sh`, `submit-plan.sh`, `test:e2e`) use ABI 133 natively.
- Git worktrees created by `WorktreeFamiliar` run `pnpm install --frozen-lockfile && node scripts/rebuild-for-electron.js` to provision dependencies and ensure the correct ABI.

### Troubleshooting

#### "vitest: not found" or "command not found" in worktrees

**Cause**: Package is trying to run `vitest` directly instead of using `electron-vitest` script.

**Fix**: Update the package's `package.json` to use:
```json
"test": "../../scripts/electron-vitest run"
```

This uses a relative path to the script (no node_modules needed) and works in both main repo and worktrees.

#### `NODE_MODULE_VERSION` mismatch errors

**Cause**: `better-sqlite3` was compiled for wrong ABI or test is running under wrong Node runtime.

**Fix**: Rebuild for Electron ABI:
```bash
pnpm run rebuild:electron
```

Do **not** run `pnpm rebuild better-sqlite3` directly — that rebuilds for system Node (ABI 127) which will break Electron.

#### Plan tasks failing with test errors in worktrees

**Cause**: Plan task command uses `npx vitest run` or direct vitest call instead of `pnpm test`.

**Fix**: Always use `pnpm test` in plan task commands. `WorktreeFamiliar` strips `ELECTRON_RUN_AS_NODE` from task environments, but `pnpm test` → `electron-vitest` restores it correctly.

#### Verify worktree provisioning end-to-end

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
