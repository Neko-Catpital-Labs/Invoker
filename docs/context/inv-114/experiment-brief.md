# INV-114 Experiment Brief

Date: 2026-05-16

## Scope

INV-114 needs deterministic proof that restart and recreate worktree behavior is evidence-backed and reviewable. This brief covers these concrete files under test:

- `packages/execution-engine/src/worktree-executor.ts`
- `packages/execution-engine/src/worktree-discovery.ts`
- `packages/execution-engine/src/__tests__/task-runner.test.ts`

The supporting regression surface also includes:

- `packages/execution-engine/src/__tests__/branch-utils.test.ts`
- `packages/execution-engine/src/__tests__/worktree-discovery.test.ts`
- `packages/execution-engine/src/__tests__/repo-pool.test.ts`

## Selected Design

Use branch names with both lifecycle identity and content identity:

```text
experiment/<actionId>/<lifecycleTag>-<contentHash>
```

Evidence points:

- `worktree-executor.ts` resolves the plan base revision, hashes the stable spec inputs (`actionId`, command, prompt, upstream commit hashes, base HEAD), then builds the branch with the request lifecycle tag.
- `worktree-discovery.ts` parses only the new branch shape, finds reusable worktrees by `actionId + contentHash`, and treats cross-action `contentHash` matches as observable collisions rather than fatal branch conflicts.
- `task-runner.test.ts` proves recreate-style executions request a fresh workspace when branch/workspace state is absent, while restart-style executions remain reusable when branch or workspace state is still present.

## Competing Design Considered

Competing design: salt the content hash with lifecycle identity and keep a flatter branch name such as `experiment/<actionId>-<saltedHash>`.

Verdict: rejected.

Reasons:

- It makes equivalent task specs produce different hashes across recreates, so cache-equivalent reuse cannot be proven by comparing content identity.
- It couples workspace freshness to the hash, making branch uniqueness and spec identity the same mechanism.
- It cannot cleanly distinguish a real content collision from expected lifecycle churn without re-parsing task metadata outside the branch name.

The selected design separates concerns: `contentHash` is the spec fingerprint; `lifecycleTag` gives branch/workspace uniqueness for recreates and attempts.

## Deterministic Commands

Run from the repository root.

### Branch and Discovery Contract

Command:

```sh
pnpm --dir packages/execution-engine exec vitest run src/__tests__/branch-utils.test.ts src/__tests__/worktree-discovery.test.ts
```

Expected output:

```text
✓ src/__tests__/branch-utils.test.ts (55 tests)
✓ src/__tests__/worktree-discovery.test.ts (26 tests)
Test Files  2 passed (2)
Tests  81 passed (81)
```

Thresholds:

- Exit code must be `0`.
- `computeContentHash` must remain deterministic for identical inputs.
- Branch parsing must reject legacy `experiment/<actionId>-<sha8>` names.
- Discovery must return a content reuse hit only when both `actionId` and `contentHash` match.
- Cross-action hash collisions must be reported by collision discovery without blocking a separate branch.

Verdict: pass means the branch format is deterministic and reviewable.

### Recreate and Restart Semantics

Command:

```sh
pnpm --dir packages/execution-engine exec vitest run src/__tests__/task-runner.test.ts -t "fresh workspace|restart-style|attemptId and executionGeneration|deduplicates concurrent launches"
```

Expected output:

```text
✓ src/__tests__/task-runner.test.ts (203 tests | 198 skipped)
Test Files  1 passed (1)
Tests  5 passed | 198 skipped (203)
```

Thresholds:

- Exit code must be `0`.
- `recreateTask`-style executions with no persisted branch/workspace must set `request.inputs.freshWorkspace === true`.
- `recreateWorkflow`-style root executions with no persisted branch/workspace must set `request.inputs.freshWorkspace === true`.
- Restart-style executions with persisted branch or workspace state must set `request.inputs.freshWorkspace === false`.
- Attempts must preserve `attemptId` and `executionGeneration` from request through completion.
- Concurrent launches for the same attempt must call executor `start` exactly once.

Verdict: pass means TaskRunner sends deterministic lifecycle intent to the worktree executor.

### Pool Collision and Freshness Behavior

Command:

```sh
pnpm --dir packages/execution-engine exec vitest run src/__tests__/repo-pool.test.ts -t "content-addressable reuse"
```

Expected output:

```text
✓ src/__tests__/repo-pool.test.ts (31 tests | 28 skipped)
Test Files  1 passed (1)
Tests  3 passed | 28 skipped (31)
```

Thresholds:

- Exit code must be `0`.
- A content-equivalent leftover worktree for the same action must be reused by renaming to the current lifecycle branch.
- `forceFresh=true` must allocate a different workspace path even when the target content hash matches an existing worktree.
- Two different action IDs that share the same eight-character content hash must still provision separate worktrees.

Verdict: pass means the selected design handles reuse, recreate freshness, and hash collisions independently.

## Observed Smoke Result

On 2026-05-16 in this checkout, the package-level execution-engine suite was also started with:

```sh
pnpm --filter @invoker/execution-engine test -- src/__tests__/task-runner.test.ts src/__tests__/worktree-discovery.test.ts src/__tests__/branch-utils.test.ts src/__tests__/repo-pool.test.ts
```

Vitest expanded this through the package script into the package suite rather than only the listed files. The final summary was:

```text
Test Files  46 passed (46)
Tests  953 passed (953)
```

During the run, these relevant files reported passing:

```text
✓ src/__tests__/task-runner.test.ts (203 tests)
✓ src/__tests__/worktree-executor.test.ts (63 tests)
✓ src/__tests__/repo-pool.test.ts (31 tests)
✓ src/__tests__/branch-utils.test.ts (55 tests)
✓ src/__tests__/worktree-discovery.test.ts (26 tests)
```

This is useful as a smoke signal, but the deterministic reviewer commands above are the contract for INV-114.

## Decision Threshold

Accept the selected architecture only if all deterministic commands exit `0` and meet their threshold bullets. Reject or revisit it if any command fails, if branch parsing accepts legacy ambiguous shapes, if same-spec hashes vary across recreates, or if force-fresh recreate flows reuse an existing workspace path.
