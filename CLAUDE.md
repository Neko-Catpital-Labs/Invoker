# Invoker Project Instructions

## Planning Rules

- Every step in a plan MUST be testable. Each implementation step must have a corresponding verification with a concrete, executable command that produces a clear pass/fail exit code (e.g. `pnpm test`, `git diff --name-only`). Do not use AI prompts for test tasks — use commands only.

## Native Module ABI

This project uses `better-sqlite3`, a native C++ addon that must be compiled for a specific Node.js ABI. Electron bundles its own Node.js with a **different ABI** than system Node, even when the major version matches:

| Runtime | ABI | Used by |
|---------|-----|---------|
| System Node v22 | 127 | scripts, packages without native deps |
| Electron 35 | 133 | app, E2E tests, headless mode |

**The project standardizes on Electron's ABI (133).** The binary is compiled once for Electron and all native-module tests run under Electron's Node via `ELECTRON_RUN_AS_NODE=1`.

### How it works

- `pnpm install` triggers `postinstall` → `scripts/rebuild-for-electron.js`, which runs `scripts/check-native-modules.js` under Electron's Node (`ELECTRON_RUN_AS_NODE=1`) to compile `better-sqlite3` for ABI 133.
- `onlyBuiltDependencies` in root `package.json` allows both `better-sqlite3` (native compile) and `electron` (binary download) to run their install scripts.
- Packages that use `better-sqlite3` in tests (`persistence`, `surfaces`, `app`) run vitest through `scripts/electron-vitest`, which executes vitest under Electron's bundled Node.js.
- Packages without native deps (`core`, `graph`, `protocol`, `transport`, `executors`, `ui`) use system Node normally.
- All Electron entry points (`dev`, `run.sh`, `submit-plan.sh`, `test:e2e`) use ABI 133 natively.
- Git worktrees created by `WorktreeFamiliar` run `pnpm install --frozen-lockfile && node scripts/rebuild-for-electron.js` to provision dependencies and ensure the correct ABI.

### Troubleshooting

If you see `NODE_MODULE_VERSION` errors, run:

```bash
pnpm run rebuild:electron
```

Do **not** run `pnpm rebuild better-sqlite3` directly — that rebuilds for system Node (ABI 127) which will break Electron.

To verify worktree provisioning works end-to-end:

```bash
bash scripts/test-worktree-provisioning.sh
```

### Plan task commands

Plan YAML tasks that run tests **must** use `pnpm test`, never `npx vitest run`. Task subprocesses run under system Node (ABI 127) because `LocalFamiliar` strips `ELECTRON_RUN_AS_NODE` from the environment. Running `npx vitest run` loads `better-sqlite3` (compiled for ABI 133) under system Node (ABI 127) and crashes with `NODE_MODULE_VERSION` mismatch.

`pnpm test` works correctly because it calls `scripts/electron-vitest`, which sets `ELECTRON_RUN_AS_NODE=1` and runs vitest under Electron's Node (ABI 133), matching the binary.

```yaml
# Wrong — crashes with ABI mismatch:
command: "cd packages/surfaces && npx vitest run"

# Right — uses electron-vitest, ABI matches:
command: "cd packages/surfaces && pnpm test"
```
