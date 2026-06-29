# INV-143 Experiment Brief

Date: 2026-06-29

## Objective

Establish deterministic proof for INV-143 so architecture choices are evidence-backed and reviewable. The proof must stay tied to concrete files under test and avoid relying on live workflow state, external services, or wall-clock-sensitive integration behavior beyond bounded local test timeouts.

## Files Under Test

- `submit-plan.sh`: headless plan submission entrypoint, Electron mode setup, Linux sandbox fallback, and software GL export.
- `packages/workflow-core/src/scheduler.ts`: in-memory priority queue, max-concurrency accounting, attempt identity tracking, queue inspection, and cancellation helpers.
- `packages/workflow-core/src/__tests__/scheduler.test.ts`: deterministic scheduler contract coverage.
- `packages/app/src/__tests__/headless-client.test.ts`: deterministic LocalBus coverage for headless owner discovery, delegation, bootstrap, stale-bus recovery, query behavior, and no-track timeout handling.

## Selected Approach

Use package-local deterministic checks as the proof boundary:

1. Validate the shell entrypoint contract without launching Electron.
2. Run the scheduler unit suite against `TaskScheduler`.
3. Run the headless client LocalBus suite against owner delegation and query behavior.

This approach proves the architecture at the same boundaries where the design decisions live: entrypoint normalization in `submit-plan.sh`, scheduling invariants in `scheduler.ts`, and shared-owner delegation behavior in `headless-client.test.ts`.

## Competing Design

Alternative: run a full `./submit-plan.sh <plan.yaml>` end-to-end workflow and use the resulting workflow status as the proof artifact.

Verdict: not selected for INV-143 deterministic proof. A full submit run exercises useful integration behavior, but it depends on a built Electron main bundle, local sandbox permissions, renderer/runtime startup, available executors, and mutable workflow state. Those variables make it better suited for integration confidence than for a reviewable deterministic architecture proof. The selected package-local checks are narrower, but they fail directly at the architectural contracts being reviewed.

## Commands and Expected Output

### 1. Shell Entrypoint Contract

Command:

```bash
bash -n submit-plan.sh
```

Expected output:

```text
<no output>
```

Expected exit code: `0`

Command:

```bash
./submit-plan.sh
```

Expected output:

```text
Usage: ./submit-plan.sh <plan.yaml>
```

Expected exit code: `1`

Verdict threshold:

- `bash -n` must exit `0`.
- Missing-plan invocation must exit `1` and print exactly the usage line above.
- This proves the script keeps a deterministic argument guard before any Electron or environment-dependent path.

### 2. Scheduler Contract

Command:

```bash
pnpm --filter @invoker/workflow-core exec vitest run src/__tests__/scheduler.test.ts
```

Expected summary:

```text
Test Files  1 passed (1)
Tests       24 passed (24)
```

Observed on 2026-06-29:

```text
src/__tests__/scheduler.test.ts (24 tests) 64ms
Test Files  1 passed (1)
Tests       24 passed (24)
Duration    1.88s
```

Verdict threshold:

- Exit code must be `0`.
- Exactly one scheduler test file must pass.
- At least 24 scheduler tests must pass.
- No skipped, failed, or flaky retry-dependent assertions are acceptable.

Architecture verdict:

`TaskScheduler` supports deterministic priority ordering, bounded `maxConcurrency`, task and attempt identity compatibility, queue snapshots, job removal, and `killAll` accounting. This supports the selected in-memory scheduler contract while persisted leases remain the orchestrator source of truth when `takeNext()` is used.

### 3. Headless Owner Delegation Contract

Command:

```bash
pnpm --filter @invoker/app exec vitest run src/__tests__/headless-client.test.ts
```

Expected summary:

```text
Test Files  1 passed (1)
Tests       18 passed (18)
```

Observed on 2026-06-29:

```text
src/__tests__/headless-client.test.ts (18 tests) 68779ms
Test Files  1 passed (1)
Tests       18 passed (18)
Duration    71.83s
```

Verdict threshold:

- Exit code must be `0`.
- Exactly one headless-client test file must pass.
- At least 18 headless-client tests must pass.
- Total duration should remain under 90 seconds on a normal local development machine.
- Tests that intentionally wait under load must still complete within their declared Vitest timeouts.

Architecture verdict:

The headless client keeps mutating commands on a reachable owner endpoint, bootstraps a standalone owner when needed, refreshes stale buses, handles owner restart windows, avoids silent fallback for owner-only queries, and preserves host-runtime fallback for non-mutating commands. This supports the selected shared-owner architecture without requiring a full workflow submission for every review proof.

## Decision

Selected: deterministic package-local proof plus shell entrypoint validation.

Rejected for this proof: full `submit-plan.sh` workflow execution as the primary evidence.

Acceptance threshold for INV-143:

- All three command groups above meet their exit-code and output thresholds.
- The proof references the concrete implementation and test files listed above.
- Any future architecture change that modifies owner delegation, scheduler accounting, or submit-plan entrypoint behavior must update this brief or add an equivalent deterministic proof artifact.
