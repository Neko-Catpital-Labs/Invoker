# INV-86 — Experiment Brief: Headless CLI Architecture Proof

**Status:** active · **Date:** 2026-06-22 · **Owner:** WF INV-86

## One-sentence outcome

The headless CLI keeps **one writer** by routing every mutating command through a
single owner process, while read-only commands run locally — and the experiment
below proves it deterministically with four runnable commands, each with an exact
pass/fail threshold.

## What this experiment decides

INV-86 locks in *how a `--headless` command reaches the database*. Two designs
were on the table:

- **Selected design — single-writer owner with delegation.** The same Electron
  binary serves GUI and headless. Mutating commands (`run`, `resume`, `approve`,
  `retry`, …) are **delegated** over IPC to one owner process that holds the DB
  writer lock; read-only commands (`status`, `queue`, `query`) run in-process.
  When no owner exists, a standalone owner is **bootstrapped** on demand.
- **Competing design — direct multi-writer.** Every headless invocation opens
  the writable DB itself and mutates directly (no owner, no delegation).

The competing design is rejected because concurrent CLI calls would each grab a
writable SQLite handle, racing the single-writer invariant that
`acquireDbWriterLock` enforces. The experiment proves the selected design holds
its three load-bearing behaviors: **command classification**, **owner
delegation/bootstrap**, and **skill-source resolution** across packaged vs repo
builds — plus a type gate that the delegation facade compiles for all callers.

## Files under test (concrete)

| File | Role in the selected design |
| --- | --- |
| `packages/app/src/main.ts` | Owner process. Detects `--headless`, classifies read-only vs mutating, serves `headless.run` / `headless.resume` / `headless.exec` / `headless.query` over the message bus, and holds the DB writer lock via `acquireDbWriterLock`. |
| `packages/app/src/headless-client.ts` | Delegating client. `resolveOwnerAndDelegate` runs the discover → reachable → refresh → bootstrap phases; read-only `query`/`queue` short-circuit through `delegateReadOnlyQuery`. |
| `packages/app/src/bundled-skills.ts` | Skill subsystem. Resolves the skill source root (packaged `resourcesPath/skills` vs repo `skills/`) and installs idempotently with a content hash + manifest. |

## Deterministic proof commands

Run from the repository root unless noted. Each command is command-only (no AI),
produces an exit code, and has a fixed expected result. **Verdict = PASS only if
both the exit code and the test count match exactly.**

### 1. Command classification — routing decision

```bash
cd packages/app && pnpm test src/__tests__/headless-command-classification.test.ts
```

- **Proves:** mutating vs read-only commands are split correctly, so only
  mutating commands are delegated to the owner (`main.ts` routing).
- **Expected output:** `Tests  5 passed (5)`
- **Threshold:** exit `0` and exactly `5` passing tests.
- **Verdict:** PASS → routing contract holds. FAIL → a command could reach the
  wrong path (a mutation running locally = multi-writer risk).

### 2. Owner delegation & bootstrap — the core of the selected design

```bash
cd packages/app && pnpm test src/__tests__/headless-client.test.ts
```

- **Proves:** the discover → reachable → refresh → bootstrap delegation phases,
  no-track timeout handling under load, and read-only query fallback behavior
  (`headless-client.ts`).
- **Expected output:** `Tests  18 passed (18)` (runtime ≈ 70s; several cases
  intentionally exercise multi-second timeout windows).
- **Threshold:** exit `0` and exactly `18` passing tests.
- **Verdict:** PASS → delegation reaches exactly one owner. FAIL → the competing
  multi-writer path could leak through.

### 3. Skill-source resolution — packaged vs repo

```bash
cd packages/app && pnpm test src/__tests__/bundled-skills.test.ts
```

- **Proves:** the source root resolves correctly for packaged and repo builds
  and install is idempotent via the directory hash + manifest
  (`bundled-skills.ts`).
- **Expected output:** `Tests  2 passed (2)`
- **Threshold:** exit `0` and exactly `2` passing tests.
- **Verdict:** PASS → skills resolve in both build shapes. FAIL → packaged owner
  would install from the wrong root.

### 4. Type gate — delegation facade compiles for all callers

```bash
pnpm run check:types
```

- **Proves:** the owner/client IPC contract types line up across `main.ts`,
  `headless-client.ts`, and their callers (this change is type-level at the
  boundary, so typecheck is the cross-caller gate).
- **Expected output:** `tsc` prints nothing and exits `0`.
- **Threshold:** exit `0`, zero type errors.
- **Verdict:** PASS → contract is sound. FAIL → a caller disagrees with the
  delegation shape.

## Aggregate verdict

The selected single-writer-owner design is **accepted** only when commands 1–4
all return PASS:

| # | Command | Threshold |
| --- | --- | --- |
| 1 | `pnpm test …/headless-command-classification.test.ts` | exit 0, 5 passed |
| 2 | `pnpm test …/headless-client.test.ts` | exit 0, 18 passed |
| 3 | `pnpm test …/bundled-skills.test.ts` | exit 0, 2 passed |
| 4 | `pnpm run check:types` | exit 0, no errors |

If any command fails its threshold, the evidence does not support the selected
design and the change must not merge. The competing direct-multi-writer design
is rejected by construction: it has no command that can pass #1 or #2 without
reintroducing concurrent writable DB handles.

## Reproducibility notes

- Commands 1–3 were run on 2026-06-22 and observed PASS at the counts above
  (combined run: `Tests 25 passed (25)`).
- Tests run under system Node via `vitest run` with `sql.js` (WASM SQLite), so
  no native SQLite addon or Electron test runtime is required.
- Do not set `INVOKER_HEADLESS_STANDALONE=1` in the shell when running these —
  it changes the headless routing path and is not part of this proof.
