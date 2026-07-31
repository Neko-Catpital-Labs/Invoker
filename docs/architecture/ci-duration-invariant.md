# CI Duration Invariant

## Rule

PR-facing quality jobs must stay cheap. The default cap is **5 minutes**.
The dedicated `UI Vitest` lane has a **10-minute** cap because checkout,
cache restore, dependency setup, and the scoped `@invoker/ui` suite can exceed
the default budget on CI. Playwright shards have a separate **30-minute** cap.

Enforced by:

- `timeout-minutes: 5` on `quality-required` and `quality-extra` in `.github/workflows/ci.yml`
- `timeout-minutes: 10` on `ui-vitest`, pinned to `Runner_Vitest` and `pnpm --filter @invoker/ui test`
- `timeout-minutes: 30` plus shard-size limits on `playwright`
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
- Do **not** raise a job above its explicit cap. Split shards or move work to
  the daily battery instead.

## Exempt (may be longer)

`build-artifacts`, `required-fast`, `required-fast-extra`, `e2e-proof`, `ssh`,
`optional-other`, `docker`, `scheduled-repros`.
