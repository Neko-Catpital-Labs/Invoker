# INV-74 Experiment Brief: Headless Startup Decomposition

## Problem Statement

Headless startup logic was monolithic inside `main.ts`, with no explicit boundary between owner and non-owner composition paths. Cross-surface parity (GUI vs API vs headless) was implicit and unverifiable.

## Architectural Choice Under Test

**Selected: Layered composition with explicit routing**

Decompose headless startup into three modules with clear responsibilities:

| Module | Responsibility | File |
|--------|---------------|------|
| Runtime composition facade | Freeze port adapters into read-only `RuntimeServices` | `packages/runtime-service/src/composition.ts` |
| Headless CLI + TaskRunner lifecycle | CLI parsing, output formatting, executor wiring | `packages/app/src/headless.ts` |
| Owner-delegation protocol | RPC marshaling, timeout policy, response validation | `packages/app/src/headless-delegation.ts` |

Key properties:
- `composeHeadlessStartup()` is an explicit routing target (not an implicit consumer of globals).
- `RuntimeServices` is `Object.freeze()`-d to prevent runtime mutation.
- Delegation uses typed `DelegationOutcome` union (`delegated | timeout | no-handler | protocol-error`).
- Timeout policy: 60s for workflow-scoped mutations, 5s default.

## Competing Design: Shared Singleton Composition

An alternative is a single `composeRuntimeServices()` call used by all surfaces, with a runtime flag (e.g., `isHeadless`) passed as a parameter to conditionally alter behavior.

| Criterion | Layered Routing (selected) | Shared Singleton |
|-----------|---------------------------|------------------|
| Testability | Each path testable in isolation | Must test flag branches within one function |
| Surface parity | Explicit — both paths produce frozen facades; parity is a test assertion | Implicit — parity depends on flag behavior not diverging |
| Blast radius of headless changes | Isolated to `composeHeadlessStartup` | Any headless change touches the shared factory |
| Code overhead | Two functions (~10 lines each) | One function, slightly larger with flag |
| Discovery | `grep composeHeadlessStartup` finds headless wiring | Must trace the `isHeadless` flag through the function |

**Verdict:** Layered routing wins on testability, blast radius, and discoverability. The overhead is minimal (one 4-line pass-through function).

## Experiment Commands

All commands are deterministic and produce pass/fail exit codes.

### Experiment 1: Composition Facade Contracts

**Hypothesis:** `composeRuntimeServices` and `composeHeadlessStartup` produce frozen, identity-preserving facades.

```bash
cd packages/runtime-service && pnpm test
```

**Expected output:**
```
 ✓ src/__tests__/composition.test.ts (8 tests)
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

**Threshold:** 8/8 tests pass. Exit code 0.

**What these tests verify:**
- Frozen facade rejects property mutation (`Object.freeze` enforced).
- Adapter identity is preserved (facade properties === injected adapters).
- Type contracts satisfied (all 4 ports present and typed).
- `composeHeadlessStartup` delegates to `composeRuntimeServices` (same behavior).
- Dormant bridge hook fires only when `enableDormantBridge: true`.

### Experiment 2: Owner-Delegation Protocol

**Hypothesis:** Delegation RPC enforces typed response shapes and timeout policy.

```bash
cd packages/app && pnpm exec vitest run src/__tests__/headless-delegation.test.ts src/__tests__/owner-delegation.test.ts
```

**Expected output:**
```
 ✓ src/__tests__/headless-delegation.test.ts
 ✓ src/__tests__/owner-delegation.test.ts (41 tests)
 Test Files  2 passed (2)
```

**Threshold:** All tests pass. Exit code 0.

**What these tests verify:**
- `delegationTimeoutMs` returns 60000ms for workflow-scoped commands (`rebase`, `rebase-and-retry`, `recreate-with-rebase`, `restart`) and 5000ms otherwise.
- `tryDelegateExec` / `tryDelegateRun` / `tryDelegateResume` produce correct `DelegationOutcome` variants.
- Response shape validation: rejects non-object responses, missing `tasks` array, missing `workflowId`/`ok`.
- Protocol-error outcome on malformed responses (e.g., `{ success: true }` instead of `{ ok: true }`).
- Timeout racing with `Symbol('delegation-timeout')`.

### Experiment 3: Headless-to-Main Startup Parity

**Hypothesis:** Both startup paths produce structurally equivalent facades with identical adapter references.

```bash
cd packages/app && pnpm exec vitest run src/__tests__/headless-runtime-bridge.test.ts src/__tests__/main-runtime-bridge.test.ts
```

**Expected output:**
```
 ✓ src/__tests__/headless-runtime-bridge.test.ts
 ✓ src/__tests__/main-runtime-bridge.test.ts
 Test Files  2 passed (2)
```

**Threshold:** All tests pass. Exit code 0.

**What these tests verify:**
- `composeHeadlessStartup` and `composeRuntimeServices` produce equivalent facades.
- Both facades are frozen (mutation throws).
- Independent calls produce distinct facade objects (no shared singleton state).
- Adapter references are identical across both paths (identity, not deep-equal).

### Experiment 4: Type Safety

**Hypothesis:** Port contracts and composition types are sound across the runtime-service and runtime-domain packages.

```bash
pnpm exec tsc --noEmit -p packages/runtime-service/tsconfig.json && pnpm exec tsc --noEmit -p packages/runtime-domain/tsconfig.json
```

**Expected output:** No output (clean compilation).

**Threshold:** Exit code 0 for both packages.

**What this verifies:**
- `RuntimeServices` interface matches the port types from `@invoker/runtime-domain`.
- `RuntimeServiceDeps` slot accepts all four port types.
- `composeHeadlessStartup` return type is assignable to `RuntimeServices`.
- No type errors in the composition or port layers.

## Files Under Test

| File | Package | Role |
|------|---------|------|
| `packages/runtime-service/src/composition.ts` | @invoker/runtime-service | Composition factory + headless routing |
| `packages/app/src/headless.ts` | @invoker/app | CLI execution, TaskRunner lifecycle, `HeadlessDeps` interface |
| `packages/app/src/headless-delegation.ts` | @invoker/app | Owner-delegation RPC protocol |
| `packages/runtime-service/src/__tests__/composition.test.ts` | @invoker/runtime-service | Facade immutability + port identity |
| `packages/app/src/__tests__/headless-delegation.test.ts` | @invoker/app | Timeout policy + delegation outcome types |
| `packages/app/src/__tests__/owner-delegation.test.ts` | @invoker/app | Full delegation lifecycle + response validation |
| `packages/app/src/__tests__/headless-runtime-bridge.test.ts` | @invoker/app | Headless-to-main parity |
| `packages/app/src/__tests__/main-runtime-bridge.test.ts` | @invoker/app | Main startup composition |
| `packages/runtime-domain/src/ports.ts` | @invoker/runtime-domain | Port interfaces (WorkspaceProbe, ContainerProbe, etc.) |

## Aggregate Verdict Criteria

| # | Experiment | Pass condition |
|---|-----------|----------------|
| 1 | Composition facade | 8/8 tests, exit 0 |
| 2 | Owner-delegation protocol | All tests pass, exit 0 |
| 3 | Startup parity | All tests pass, exit 0 |
| 4 | Type safety | Both packages compile, exit 0 |

**Overall verdict: PASS** if all 4 experiments pass. Any single failure invalidates the architecture proof.

## Run All Experiments (Single Command)

```bash
(cd packages/runtime-service && pnpm test) && \
(cd packages/app && pnpm exec vitest run \
  src/__tests__/headless-delegation.test.ts \
  src/__tests__/owner-delegation.test.ts \
  src/__tests__/headless-runtime-bridge.test.ts \
  src/__tests__/main-runtime-bridge.test.ts) && \
pnpm exec tsc --noEmit -p packages/runtime-service/tsconfig.json && \
pnpm exec tsc --noEmit -p packages/runtime-domain/tsconfig.json
```

Exit code 0 = all experiments pass.
