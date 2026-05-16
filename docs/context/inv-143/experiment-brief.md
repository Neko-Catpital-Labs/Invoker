# INV-143 Experiment Brief

## Goal

Establish deterministic proof that INV-143 should keep scheduling and headless mutation ownership inside the Invoker application/runtime boundary, with `submit-plan.sh` as the reproducible headless entrypoint.

## Files under test

- `submit-plan.sh`
- `packages/workflow-core/src/scheduler.ts`
- `packages/workflow-core/src/__tests__/scheduler.test.ts`
- `packages/app/src/__tests__/headless-client.test.ts`

## Selected design

Use the existing in-process `TaskScheduler` plus headless owner delegation:

- `submit-plan.sh` resolves the plan path, normalizes Electron/Linux runtime flags, and calls `packages/app/dist/main.js --headless run`.
- `TaskScheduler` remains pure and deterministic: priority queue, explicit running set, max concurrency, attempt-aware completion, no I/O.
- Headless mutating commands delegate to a reachable owner endpoint or bootstrap a standalone-capable owner before delegation.

This keeps architectural responsibility split cleanly: shell entrypoint normalizes runtime launch, workflow-core owns deterministic scheduling, app headless code owns process/owner discovery.

## Competing design considered

Move scheduling and headless mutation execution into `submit-plan.sh` by spawning one OS process per runnable task and tracking process state in shell or temporary files.

Verdict: reject.

Reasons:

- It duplicates scheduler state outside `packages/workflow-core/src/scheduler.ts`.
- It cannot exercise attempt identity, owner refresh, stale-bus retry, and no-track delegation paths covered by `packages/app/src/__tests__/headless-client.test.ts`.
- It makes deterministic unit proof harder because correctness depends on OS process timing rather than pure scheduler state transitions.

## Deterministic commands

Run from the repository root.

```bash
pnpm --filter @invoker/workflow-core exec vitest run src/__tests__/scheduler.test.ts
```

Expected output:

```text
✓ src/__tests__/scheduler.test.ts (24 tests)
Test Files  1 passed (1)
Tests  24 passed (24)
```

Thresholds:

- 24/24 scheduler tests pass.
- No skipped scheduler tests.
- Runtime is not a correctness gate, but should remain comfortably under 5 seconds on a normal dev machine because this file has no I/O.

Verdict:

- Pass proves priority ordering, max concurrency, capacity release, kill-all counts, attempt ID tracking, queued-job snapshots, remove-job behavior, and running-job reporting.

```bash
pnpm --filter @invoker/app exec vitest run src/__tests__/headless-client.test.ts
```

Expected output:

```text
✓ src/__tests__/headless-client.test.ts (19 tests)
Test Files  1 passed (1)
Tests  19 passed (19)
```

Thresholds:

- 19/19 headless-client tests pass.
- No skipped headless-client tests.
- Slow-path tests are expected and bounded:
  - long no-track delegation under load completes before each 15 second test timeout.
  - repeated owner loss completes before the 30 second test timeout.
  - missing `query ui-perf` owner fails deterministically before its 30 second test timeout.

Verdict:

- Pass proves mutating commands delegate to GUI and standalone owners, standalone owner bootstrap happens once when needed, stale-bus recovery refreshes the message bus, slow no-track delegation uses the longer timeout, query commands use owner endpoints where required, and unsupported ownerless `ui-perf` queries fail instead of silently falling back.

Optional broad proof commands run during this brief creation:

```bash
pnpm --filter @invoker/workflow-core test -- --run packages/workflow-core/src/__tests__/scheduler.test.ts
pnpm --filter @invoker/app test -- --run packages/app/src/__tests__/headless-client.test.ts
```

Observed output from this workspace:

```text
@invoker/workflow-core: Test Files 44 passed (44); Tests 987 passed (987)
@invoker/app: Test Files 59 passed (59); Tests 915 passed | 1 skipped (916)
```

Note: these broad commands passed, but the package script forwarded the extra path argument in a way that let Vitest discover full package suites. Use the `pnpm --filter ... exec vitest run <file>` commands above for deterministic narrow proof.

## Expected architecture evidence

Evidence from `packages/workflow-core/src/scheduler.ts`:

- `enqueue` inserts by binary search and preserves high-priority-first order.
- `dequeue` mutates running state only when under `maxConcurrency`.
- `takeNext` intentionally does not mutate running state, supporting persisted attempt leases as source of truth.
- `completeJob` can free by attempt ID or task ID.
- `getQueuedJobs`, `getRunningTaskIds`, `getRunningAttemptIds`, and `getRunningJobs` expose reviewable queue/running state without I/O.

Evidence from `packages/app/src/__tests__/headless-client.test.ts`:

- Mutating commands `retry`, `rebase`, `recreate`, `run`, and `resume` delegate to the correct owner channels.
- No-track execution uses longer delegation timeouts under load.
- Bootstrap and refresh paths recover from missing owners, stale buses, and restarted owners.
- Owner-only queries such as `ui-perf` fail when no owner endpoint exists.

Evidence from `submit-plan.sh`:

- The script resolves relative plan paths against the caller's directory.
- The script rejects a missing plan path before launching Electron.
- It unsets `ELECTRON_RUN_AS_NODE`.
- It applies Linux sandbox and software rendering flags deterministically.
- It invokes the Electron app in headless mode through `--headless run`.

## Decision

Keep the selected design. The deterministic test surface proves scheduler behavior independently of I/O and proves headless owner delegation across normal, bootstrap, stale-bus, slow-response, query, and failure paths. The implementation update consumes this conclusion by keeping `submit-plan.sh` as a normalized Electron `--headless run` entrypoint, keeping `TaskScheduler` pure, and adding explicit `headless.run` proof for an existing GUI owner.

Acceptance threshold for INV-143: both narrow commands above must pass exactly, and future changes that alter `submit-plan.sh`, `TaskScheduler`, or headless owner delegation must update this brief or add equivalent proof.
