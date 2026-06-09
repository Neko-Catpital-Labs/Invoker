# INV-143 Experiment Brief

Date: 2026-06-09

## Question

Can INV-143 rely on a shared owner plus durable launch-dispatch design instead of letting each headless invocation or the in-memory scheduler own mutation/concurrency decisions?

## Files Under Test

- `submit-plan.sh`
- `packages/workflow-core/src/scheduler.ts`
- `packages/workflow-core/src/__tests__/scheduler.test.ts`
- `packages/app/src/headless-client.ts`
- `packages/app/src/__tests__/headless-client.test.ts`

## Selected Design

Use `submit-plan.sh` as the deterministic headless entrypoint, route mutating headless commands to a standalone-capable shared owner, and keep `TaskScheduler` as a pure priority queue. Concurrency is enforced outside `TaskScheduler` by persisted active attempts and the durable `task_launch_dispatch` path; `TaskScheduler.maxConcurrency` remains informational for compatibility and status output.

Evidence in `packages/workflow-core/src/scheduler.ts`:

- `enqueue()` inserts by descending priority.
- `takeNext()` drains without checking `maxConcurrency`.
- `getStatus()` reports `queueLength` and the constructor's `maxConcurrency`, but does not gate dispatch.

Evidence in `packages/app/src/headless-client.ts`:

- `runHeadlessClientCommand()` delegates read-only live-owner queries before host fallback.
- Mutating commands use shared-owner delegation unless `INVOKER_HEADLESS_STANDALONE=1` or `owner-serve` is active.
- No-track delegated mutations use the post-bootstrap timeout path: `POST_BOOTSTRAP_NO_TRACK_DELEGATION_TIMEOUT_MS = 90_000`.

## Alternative Considered

Competing design: keep concurrency and mutation ownership local to each headless process, with `TaskScheduler` retaining a running set / `maxConcurrency` gate and `runElectronHeadless()` as the default mutation path.

Rejected because it makes behavior depend on per-process state and owner discovery races. The current tests demonstrate the selected design's reviewable boundary: local scheduler behavior is deterministic and small, while headless mutation routing is explicitly delegated to a standalone owner unless the standalone escape hatch is enabled.

## Deterministic Commands

Run from repo root.

### 1. Entrypoint Syntax Proof

Command:

```bash
bash -n submit-plan.sh
```

Expected output: none.

Expected exit code: `0`.

Verdict: pass. Confirms `submit-plan.sh` is parseable before Electron launch.

Command:

```bash
./submit-plan.sh
```

Expected output:

```text
Usage: ./submit-plan.sh <plan.yaml>
```

Expected exit code: `1`.

Verdict: pass. Confirms the entrypoint fails deterministically before side effects when no plan is supplied.

Threshold: any syntax error, missing usage text, or non-`1` missing-argument exit fails the entrypoint proof.

### 2. Scheduler Priority-Queue Proof

Command:

```bash
pnpm --filter @invoker/workflow-core exec vitest run src/__tests__/scheduler.test.ts
```

Expected output pattern:

```text
✓ src/__tests__/scheduler.test.ts (16 tests)
Test Files  1 passed (1)
Tests  16 passed (16)
```

Observed output:

```text
✓ src/__tests__/scheduler.test.ts (16 tests) 4ms
Test Files  1 passed (1)
Tests  16 passed (16)
Duration  430ms
```

Verdict: pass. Confirms the selected scheduler surface: priority order, FIFO within equal priority, queue inspection copy semantics, removal by task or attempt id, queue clearing, and no `maxConcurrency` gate in `takeNext()`.

Threshold: exactly `16 passed (16)`, zero failures, and the `does not impose any maxConcurrency limit` case must remain present in `packages/workflow-core/src/__tests__/scheduler.test.ts`.

### 3. Headless Shared-Owner Delegation Proof

Command:

```bash
env -u INVOKER_HEADLESS_STANDALONE pnpm --filter @invoker/app exec vitest run src/__tests__/headless-client.test.ts
```

Expected output pattern:

```text
✓ src/__tests__/headless-client.test.ts (18 tests)
Test Files  1 passed (1)
Tests  18 passed (18)
```

Observed output:

```text
✓ src/__tests__/headless-client.test.ts (18 tests) 68459ms
Test Files  1 passed (1)
Tests  18 passed (18)
Duration  68.91s
```

Relevant observed slow-case thresholds:

- Existing standalone owner under no-track load: about `9000ms`.
- Post-bootstrap no-track load: about `9001ms`.
- Re-bootstrap after repeated owner loss: about `21857ms`.
- Queue query service not ready after owner ping: about `8503ms`.
- No owner for `query ui-perf`: about `20084ms`.

Verdict: pass. Confirms mutating commands delegate to a standalone-capable owner, GUI owners are not mutation targets, bootstrap/refresh behavior is deterministic, read-only live-owner queries do not silently fall back, and no-track delegation tolerates owner load.

Threshold: exactly `18 passed (18)`, zero failures, and run with `INVOKER_HEADLESS_STANDALONE` unset. If `INVOKER_HEADLESS_STANDALONE=1` is set, the same test is expected to fail because `runHeadlessClientCommand()` intentionally routes to `runElectronHeadless()` instead of shared-owner delegation.

## Verdict

Selected approach wins. The proof isolates the architecture into deterministic layers:

- `submit-plan.sh` provides a stable headless launch contract.
- `TaskScheduler` is a pure, reviewable priority queue with no hidden local occupancy state.
- `headless-client` delegates shared mutations to a standalone-capable owner and makes fallback behavior explicit.

The competing local-process design is rejected because it reintroduces process-local mutation ownership and concurrency state that the current tests intentionally remove from the scheduler and cover through owner delegation.
