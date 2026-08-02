# CI Duration Invariant

## Rule

Cheap PR-facing quality jobs must finish in **under 5 minutes**. The dedicated
`ui-vitest` gate has a **10 minute** cap because checkout, dependency setup, and
the current `@invoker/ui` suite take longer than the cheap quality checks.
Playwright shards keep their separate **30 minute** cap.

Enforced by:

- `timeout-minutes: 5` on `quality-required` and `quality-extra` in `.github/workflows/ci.yml`
- `timeout-minutes: 10` on `ui-vitest`
- `timeout-minutes: 30` on `playwright`
- `node scripts/test-ci-duration-invariant.mjs` (wired into root `pnpm test`)

## Why

Stacked PR pushes should stay cheap. Long Playwright batteries belong on the
twice-daily extended e2e worker (`scripts/daily-e2e-do-submit.sh`), not on
ordinary PR feedback. That includes the UI action responsiveness battery
(`optional/41-ui-action-responsiveness.sh`); see
[UI action responsiveness invariant](./ui-action-responsiveness-invariant.md).

## How to stay under budget

- Keep Playwright shards small (≤ 6 specs each).
- Prefer unit/proof vitest for regressions that do not need Electron.
- Do **not** raise cheap quality job `timeout-minutes` above 5. Split work or
  move it to the daily battery instead.
- Keep `ui-vitest` at or below 10 minutes; if it grows beyond that, split the UI
  suite before raising this invariant.

## Exempt (may be longer)

`build-artifacts`, `required-fast`, `required-fast-extra`, `e2e-proof`, `ssh`,
`optional-other`, `docker`, `scheduled-repros`.
