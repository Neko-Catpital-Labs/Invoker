# CI Duration Invariant

## Rule

PR-facing quality jobs and each Playwright shard must finish in **under 5 minutes**.

Enforced by:

- `timeout-minutes: 5` on `quality-required`, `ui-vitest`, `quality-extra`, and `playwright` in `.github/workflows/ci.yml`
- `node scripts/test-ci-duration-invariant.mjs` (wired into root `pnpm test`)

## Why

Stacked PR pushes should stay cheap. Long Playwright batteries belong on the
twice-daily extended e2e worker (`scripts/daily-e2e-do-submit.sh`), not on
ordinary PR feedback. That includes the UI action responsiveness battery
(`optional/41-ui-action-responsiveness.sh`); see
[UI action responsiveness invariant](./ui-action-responsiveness-invariant.md).

## How to stay under budget

- Keep Playwright shards small (≤ 6 specs each; currently 6 shards).
- Prefer unit/proof vitest for regressions that do not need Electron.
- Do **not** raise `timeout-minutes` above 5 for budgeted jobs — split shards
  or move work to the daily battery instead.

## Exempt (may be longer)

`build-artifacts`, `required-fast`, `required-fast-extra`, `e2e-proof`, `ssh`,
`optional-other`, `docker`, `scheduled-repros`.
