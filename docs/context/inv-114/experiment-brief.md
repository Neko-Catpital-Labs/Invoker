# INV-114 Experiment Brief: Reusable Git Optimization Primitives

## Problem

The execution-engine package has 4 independent `execGit` implementations
(`BaseExecutor.execGitSimple`, `RepoPool.execGit`, `managed-worktree-cleanup.execGit`,
`merge-runner.execGitInMergeSafe`) and 7 direct `spawn('git', ...)` callsites.
Each reimplements spawn lifecycle, error formatting, and tracing independently.

## Goal

Consolidate duplicated git spawn logic into a single tested module.
Measure duplication reduction and latency overhead to validate before adoption.

## Files Under Test

| File | Current Role |
|------|--------------|
| `packages/execution-engine/src/worktree-executor.ts` | Orchestrates worktree lifecycle via `RepoPool` and `BaseExecutor` |
| `packages/execution-engine/src/worktree-discovery.ts` | Parses `git worktree list --porcelain`; no direct git execution |
| `packages/execution-engine/src/__tests__/task-runner.test.ts` | 920 tests covering task runner, merge, branch, and git operations |
| `packages/execution-engine/src/base-executor.ts` | `execGitSimple` (protected, includes stderr+stdout in errors, traces) |
| `packages/execution-engine/src/repo-pool.ts` | `execGit` (private, stderr-only errors, no tracing) |
| `packages/execution-engine/src/managed-worktree-cleanup.ts` | `execGit` (module-level, void return, swallows stdout) |
| `packages/execution-engine/src/merge-runner.ts` | `execGitInMergeSafe` (merge-specific error handling) |
| `packages/execution-engine/src/task-runner.ts` | `execGitReadonly`/`execGitIn` (spawn-based, 35+ callsites) |

## Design Alternatives

### Alternative A: Thin Git Wrapper Module (Selected)

Stateless module exporting pure functions wrapping `spawn('git', ...)`.
Consistent error handling (stderr+stdout), tracing, and return types.

```typescript
// packages/execution-engine/src/git-primitives.ts
export function execGit(args: string[], cwd: string, opts?: GitExecOpts): Promise<string>;
```

**Pros:**
- Zero architectural blast radius. Each callsite migrates independently.
- No new state. Functions are pure (spawn, wait, return).
- Incremental adoption. Old implementations can delegate before removal.
- Testable in isolation with sandbox git repos.

**Cons:**
- No concurrent fetch deduplication.
- Each call still spawns a new process.

### Alternative B: Stateful Repo Runtime Service (Rejected)

Singleton managing connection/state cache per repo URL. Deduplicates
concurrent fetches and serializes operations.

**Pros:**
- Deduplicates concurrent `git fetch` to the same remote.
- Enforces serialization without per-caller `repoChains` maps.
- Caches resolved refs for workflow duration.

**Cons:**
- High blast radius. Requires DI across `BaseExecutor`, `RepoPool`, `TaskRunner`.
- Introduces shared mutable state (cache invalidation, lifecycle).
- `RepoPool` already serializes via `repoChains`; duplicates that concern.

### Decision

Alternative A selected. The primary problem (duplicated spawn logic,
inconsistent error handling) is solvable without shared state.
Alternative B's benefits (fetch dedup, ref caching) can layer on top later.

**Escalation gate:** Promote to Alternative B only if the wrapper misses
reliability or performance thresholds defined below.

## Experiment: Baseline Measurements

### Metric 1: Direct `spawn('git')` Count (Production Code)

**Command:**
```bash
cd packages/execution-engine/src && \
grep -rn "spawn('git'" --include='*.ts' | grep -v '__tests__' | wc -l
```

**Baseline output:** `7`

**Measured callsites:**
- `managed-worktree-cleanup.ts:13`
- `base-executor.ts:371`
- `task-runner.ts:1131`
- `task-runner.ts:1153`
- `task-runner.ts:2034`
- `task-runner.ts:2053`
- `repo-pool.ts:540`

### Metric 2: Independent `execGit` Implementation Count

**Command:**
```bash
cd packages/execution-engine/src && \
grep -rn "private execGit\|protected execGit\|function execGit\|async function execGit" \
  --include='*.ts' | grep -v 'test\|__tests__\|\.d\.ts' | wc -l
```

**Baseline output:** `4`

**Measured implementations:**
- `merge-runner.ts:118` — `execGitInMergeSafe`
- `managed-worktree-cleanup.ts:11` — `execGit` (void return)
- `base-executor.ts:366` — `execGitSimple` (stderr+stdout errors, tracing)
- `repo-pool.ts:538` — `execGit` (stderr-only errors, no tracing)

### Metric 3: Git Command Latency (Single rev-parse)

**Command:**
```bash
node -e "
const { execFileSync } = require('child_process');
const runs = 20;
const times = [];
for (let i = 0; i < runs; i++) {
  const t0 = performance.now();
  execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd() });
  times.push(performance.now() - t0);
}
const avg = times.reduce((a,b) => a+b) / times.length;
const sorted = times.slice().sort((a,b) => a-b);
const p95 = sorted[Math.floor(runs * 0.95)];
console.log('avg_ms=' + avg.toFixed(1) + ' p95_ms=' + p95.toFixed(1));
"
```

**Baseline output:** `avg_ms=5.3 p95_ms=8.7`

### Metric 4: Test Suite Baseline

**Command:**
```bash
cd packages/execution-engine && pnpm test
```

**Baseline output:** 46 test files, 920 tests passed, 0 failures.

## Post-Implementation Thresholds

| Metric | Threshold | Verdict Criteria |
|--------|-----------|------------------|
| Direct `spawn('git')` count | Drops from 7 to <=1 | **Pass** if <=1; **Fail** if >3 |
| `execGit` implementation count | Drops from 4 to 1 | **Pass** if 1; **Fail** if >2 |
| Wrapper latency overhead | avg <= baseline + 5ms | **Pass** if <=10.3ms avg; **Fail** if >15ms |
| Wrapper latency p95 | p95 <= baseline + 10ms | **Pass** if <=18.7ms; **Fail** if >25ms |
| Test regressions | 0 new failures | **Pass** if exit 0; **Fail** if any new failures |
| git-primitives.test.ts | >= 5 new tests covering success, failure, spawn error | **Pass** if all pass; **Fail** if any fail |

## Implementation Plan

### Phase 1: Create `git-primitives.ts`

1. Create `packages/execution-engine/src/git-primitives.ts` with unified
   `execGit(args, cwd, opts?)` function.
2. Include consistent tracing via `traceExecution`.
3. Include stderr+stdout in error messages (matching `BaseExecutor` behavior).

### Phase 2: Add Unit Tests

1. Create `packages/execution-engine/src/__tests__/git-primitives.test.ts`.
2. Cover: success, non-zero exit, spawn failure, tracing integration.
3. Use sandbox git repos (`mkdtempSync` + `git init`).

### Phase 3: Migrate Callsites (Deterministic Order)

Migrate in order of ascending blast radius:

1. `managed-worktree-cleanup.ts` (2 callsites, module-level)
2. `repo-pool.ts` (private `execGit` delegates to `git-primitives.execGit`)
3. `base-executor.ts` (`execGitSimple` delegates to `git-primitives.execGit`)
4. `task-runner.ts` (`execGitReadonly`/`execGitIn` delegate)

### Phase 4: Verification

Run all post-implementation threshold checks.

**Command:**
```bash
cd packages/execution-engine && pnpm test
```

Exit code 0 with 0 regressions required.

## Verdicts

| Alternative | Verdict | Rationale |
|-------------|---------|-----------|
| A: Thin wrapper | **Supported** | Zero blast radius, incremental adoption, no new state. Solves the primary duplication and inconsistency problem. |
| B: Stateful service | **Deferred** | Benefits (fetch dedup, ref caching) are optimizations. Not needed to solve the current problem. Can layer on later if Alternative A misses performance gates. |

## Evidence Checklist

- [x] Baseline measurements recorded (Metrics 1-4 above).
- [ ] `git-primitives.ts` module created with unit tests.
- [ ] At least 2 callsite migrations completed.
- [ ] Post-migration measurements recorded against thresholds.
- [ ] Final verdict confirmed: accept Alternative A or escalate to Alternative B.
