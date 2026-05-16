# INV-86 Experiment Brief

## Goal

Establish deterministic proof that INV-86 should keep bundled skill lifecycle handling in the Electron app layer while using the headless client only as a routing/delegation boundary.

## Files Under Test

- `packages/app/src/main.ts`
  - Detects direct skill installation with `--install-skills` and headless `install-skills`.
  - Wires packaged skill status/install functions into GUI IPC, diagnostics, and headless dependencies.
- `packages/app/src/headless-client.ts`
  - Parses CLI flags, delegates mutating commands to owner endpoints, and falls back to Electron headless execution for non-mutating or standalone paths.
  - Does not implement bundled skill copying or manifest logic.
- `packages/app/src/bundled-skills.ts`
  - Resolves bundled skill source roots, computes deterministic directory hashes, installs prefixed skill copies, writes `bundled-skills.json`, and reports target freshness.

## Selected Approach

Keep bundled skill lifecycle logic in `bundled-skills.ts`, expose it through `main.ts`, and keep `headless-client.ts` focused on owner discovery/delegation plus Electron fallback.

This preserves one implementation for packaged and development installs:

- source resolution is local to the app runtime (`repoRoot` in development, `process.resourcesPath/skills` when packaged);
- status and install share the same hash and manifest contract;
- GUI, diagnostics, and headless commands consume the same app-layer functions;
- the headless client remains transport-oriented and does not duplicate filesystem installation policy.

## Competing Design

Move bundled skill install/status behavior into `headless-client.ts` so `install-skills` can run without booting Electron.

Rejected because it creates a second lifecycle authority. The client would need to duplicate packaged resource discovery, managed target resolution, manifest writes, and freshness checks currently owned by `bundled-skills.ts`. It would also make GUI IPC and diagnostics depend on a CLI-side policy path, increasing review surface without improving determinism.

## Deterministic Commands

Run from the repository root.

### 1. Static Boundary Proof

```bash
rg -n "installBundledSkills|resolveBundledSkillsStatus|install-skills|runHeadlessClientCommand|invoker:get-bundled-skills-status|invoker:install-bundled-skills" \
  packages/app/src/main.ts \
  packages/app/src/headless-client.ts \
  packages/app/src/bundled-skills.ts
```

Expected output must include:

- `packages/app/src/main.ts` importing `installBundledSkills` and `resolveBundledSkillsStatus`.
- `packages/app/src/main.ts` recognizing `--install-skills` or `install-skills`.
- `packages/app/src/main.ts` passing `getBundledSkillsStatus` and `installBundledSkills` into headless dependencies.
- `packages/app/src/main.ts` registering `invoker:get-bundled-skills-status` and `invoker:install-bundled-skills`.
- `packages/app/src/bundled-skills.ts` exporting `resolveBundledSkillsStatus` and `installBundledSkills`.
- `packages/app/src/headless-client.ts` exporting `runHeadlessClientCommand`.

Expected output must not show install-copy, manifest, or target-directory implementation in `headless-client.ts`.

Verdict threshold: pass only if all ownership markers above are present and `headless-client.ts` remains free of bundled skill filesystem lifecycle implementation.

### 2. Focused Behavioral Proof

```bash
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/bundled-skills.test.ts \
  src/__tests__/headless-client.test.ts
```

Expected output:

```text
Test Files  2 passed (2)
Tests  20 passed (20)
```

The elapsed duration is expected to be roughly 70 seconds because `headless-client.test.ts` intentionally covers timeout windows and long no-track delegation behavior.

Verdict threshold: pass only if both test files pass with zero failed tests. Timing is informational; a slow pass is acceptable, but any failed assertion rejects the selected approach.

### 3. Full App Regression Guard

```bash
pnpm --filter @invoker/app exec vitest run
```

Observed on 2026-05-16:

```text
Test Files  58 passed (58)
Tests  912 passed | 1 skipped (913)
```

Verdict threshold: pass only if no app test file fails. The skipped test count may change only when the underlying suite changes and should not be interpreted as INV-86 evidence by itself.

## Expected Behavioral Evidence

The focused tests prove these concrete properties:

- `bundled-skills.test.ts` proves packaged status reports `promptRecommended` before install, installs `invoker-` prefixed skills into Codex, Claude, and Cursor target directories, preserves skill contents, writes a manifest-backed up-to-date state, and clears the packaged install prompt after install.
- `headless-client.test.ts` proves mutating commands delegate to standalone-capable owners, can delegate to reachable GUI owners, bootstrap once when no owner is present, refresh stale buses, use longer no-track timeouts after bootstrap, route read-only queue/UI performance queries through a live owner, and fail rather than silently falling back when required owner query services are absent.

## Decision

Selected approach passes if commands 1 and 2 satisfy their thresholds. Command 3 is a broader regression guard and should be run before merge when time permits.

The selected architecture is evidence-backed because deterministic tests exercise the two relevant responsibilities independently: bundled skill lifecycle behavior in `bundled-skills.ts`, and headless delegation/fallback behavior in `headless-client.ts`. The competing design is rejected because it would require duplicated filesystem lifecycle policy in the delegation client, which the current proof shows is unnecessary.
