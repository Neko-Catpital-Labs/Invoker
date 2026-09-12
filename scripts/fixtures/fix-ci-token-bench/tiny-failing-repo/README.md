# tiny-failing-repo

Minimal fixture package used as the repair target for the fix-ci poll-loop
token bench in the parent directory. It exists so a bench run has a real,
fast, offline verify command to background and poll.

- `src/sum.mjs` — one source file with a deliberate bug (`a - b` instead of `a + b`).
- `test/sum.test.mjs` — one failing test asserting `sum(2, 2) === 4`.
- `verify.mjs` — the fast verify script; exits non-zero until the bug is fixed.

Run it with `node verify.mjs` (or `pnpm verify` from this directory). It is
deliberately **not** wired into the repository's own `pnpm test` chain or CI:
this package is expected to fail.
