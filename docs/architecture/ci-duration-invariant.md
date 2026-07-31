# CI Duration Invariant

## Rule

PR-facing quality jobs must finish in **under 5 minutes** by default. The
dedicated `UI Vitest` gate has a **10-minute** budget for checkout, cache
restore, dependency setup, and the current `@invoker/ui` suite.

Enforced by:

- `timeout-minutes: 5` on `quality-required` and `quality-extra` in `.github/workflows/ci.yml`
- `timeout-minutes: 10` on `ui-vitest` in `.github/workflows/ci.yml`
- `timeout-minutes: 30` plus shard-size checks for `playwright` in `.github/workflows/ci.yml`
- `node scripts/test-ci-duration-invariant.mjs` (wired into root `pnpm test`)

## Why

Stacked PR pushes should stay cheap. Long Playwright batteries belong on the
twice-daily extended e2e worker (`scripts/daily-e2e-do-submit.sh`), not on
ordinary PR feedback. That includes the UI action responsiveness battery
(`optional/41-ui-action-responsiveness.sh`); see
[UI action responsiveness invariant](./ui-action-responsiveness-invariant.md).

## How to stay under budget

- Keep Playwright shards small (<= 6 specs each).
- Prefer unit/proof vitest for regressions that do not need Electron.
- Do **not** raise `timeout-minutes` above the named budget for a PR-facing
  job; split shards or move work to the daily battery instead.

## Exempt (may be longer)

`build-artifacts`, `required-fast`, `required-fast-extra`, `e2e-proof`,
`e2e-proof-aggregate`, `ssh`, `optional-other`, `docker`, `scheduled-repros`,
`reset-rulebook-repro`.
