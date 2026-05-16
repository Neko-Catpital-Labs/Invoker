# INV-74 Experiment Brief

## Goal

Establish deterministic proof that headless startup uses the runtime-service composition boundary while owner delegation remains isolated, observable, and reviewable.

## Files Under Test

- `packages/app/src/headless.ts`
  - Exposes `runtimeServices?: RuntimeServices` on `HeadlessDeps`.
  - Re-exports delegation helpers from `packages/app/src/headless-delegation.ts`.
- `packages/runtime-service/src/composition.ts`
  - Defines `composeRuntimeServices(deps)` as a frozen facade over supplied runtime-domain ports.
  - Defines `composeHeadlessStartup(deps)` as the headless route through the same composition shell.
- `packages/app/src/headless-delegation.ts`
  - Owns owner RPC delegation, command-aware timeout selection, malformed response handling, and delegated workflow tracking.

## Selected Approach

Use `@invoker/runtime-service` as the composition shell for runtime-domain ports, with `composeHeadlessStartup` delegating directly to `composeRuntimeServices`. Keep owner delegation in `headless-delegation.ts` and expose it through `headless.ts` without mixing delegation policy into runtime-service composition.

This gives reviewers two independently testable contracts:

- Runtime composition must be a frozen, pass-through facade with exactly the expected four ports.
- Owner delegation must preserve deterministic timeout, fallback, and protocol-validation behavior.

## Competing Design

Embed headless owner-delegation behavior inside the runtime-service composition layer, or have the owner handler block on task execution before returning delegated responses.

Verdict: rejected.

Evidence:

- `packages/runtime-service/src/composition.ts` intentionally has no `MessageBus`, `TaskRunner`, workflow, or delegation imports. Its only responsibility is typed port composition.
- `packages/app/src/__tests__/owner-delegation.test.ts` includes a deterministic competing-design check: `times out when owner handler blocks on task execution (pre-fix behavior)`. The expected result is timeout at 5 seconds, proving that blocking owner responses violate the selected delegation contract.
- `packages/app/src/__tests__/headless-runtime-bridge.test.ts` proves headless composition parity without introducing owner-delegation behavior into the runtime-service layer.

## Deterministic Commands

Run from the repository root.

### Runtime-Service Composition Contract

```sh
pnpm --dir packages/runtime-service exec vitest run src/__tests__/composition.test.ts src/__tests__/index.test.ts
```

Expected output:

```text
Test Files  2 passed (2)
Tests  10 passed (10)
```

Threshold:

- Exactly 0 failed tests.
- `composeRuntimeServices` keeps the facade frozen.
- Facade keys remain exactly `containerProbe`, `sessionProbe`, `terminalLauncher`, `workspaceProbe`.
- Supplied adapter object identity is preserved.

Verdict:

- PASS on 2026-05-16: `2 passed`, `10 passed`.

### Headless Runtime Bridge And Delegation Contract

```sh
pnpm --dir packages/app exec vitest run src/__tests__/headless-runtime-bridge.test.ts src/__tests__/owner-delegation.test.ts
```

Expected output:

```text
Test Files  2 passed (2)
Tests  61 passed (61)
```

Threshold:

- Exactly 0 failed tests.
- `composeHeadlessStartup` must produce a facade equivalent to `composeRuntimeServices`.
- Workflow-scoped `rebase`, `rebase-and-retry`, `recreate-with-rebase`, and `restart` must use `60_000` ms delegation timeout.
- Task-scoped or unrelated commands must use `5_000` ms delegation timeout.
- Available owners must return `kind: 'delegated'`.
- Missing owners must return `kind: 'no-handler'`.
- Unresponsive owners must return `kind: 'timeout'`.
- Malformed owner responses must return `kind: 'protocol-error'`.
- The competing blocking-owner design must still time out at 5 seconds in `tryDelegateRun / tryDelegateResume > times out when owner handler blocks on task execution (pre-fix behavior)`.

Verdict:

- PASS on 2026-05-16: `2 passed`, `61 passed`.

### Type Boundary Check

```sh
pnpm run check:types
```

Expected output:

```text
tsc -p tsconfig.typecheck.json
```

Threshold:

- Exit code 0.
- No TypeScript diagnostics.

Verdict:

- PASS on 2026-05-16: exit code 0, no diagnostics.

## Review Conclusion

The selected design is evidence-backed:

- Runtime-service composition is deterministic, frozen, and side-effect limited to the optional dormant bridge hook.
- Headless startup uses the same runtime-service facade as the main path through `composeHeadlessStartup`.
- Owner delegation remains app-owned, with deterministic fallback, timeout, and protocol-error outcomes.
- The competing blocking-owner design is explicitly covered and rejected by a deterministic timeout test.
