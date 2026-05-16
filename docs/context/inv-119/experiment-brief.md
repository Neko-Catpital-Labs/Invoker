# INV-119 Experiment Brief

## Purpose

Establish deterministic proof that the CI architecture for required dry-run coverage is evidence-backed and reviewable. The files under test are:

- `.github/workflows/ci.yml`
- `scripts/run-all-tests.sh`
- `scripts/test-suites/required/20-e2e-dry-run.sh`
- `scripts/e2e-dry-run/run-all.sh`
- `scripts/e2e-dry-run/cases/case-1.*.sh`

## Selected Approach

Use a CI matrix for dry-run shards and keep the local aggregate runner as the deterministic proof harness.

Evidence in `.github/workflows/ci.yml`:

- The `dry-run` job depends on `build-artifacts`.
- The job runs in `mcr.microsoft.com/playwright:v1.58.2-noble`.
- The matrix executes three dry-run shards:
  - `scripts/test-suites/required/20-e2e-dry-run.sh`
  - `scripts/test-suites/required/21-e2e-dry-run-downstream.sh`
  - `scripts/test-suites/required/22-e2e-dry-run-github.sh`
- Each shard downloads and extracts `app-build-dist.tgz` before execution.

Evidence in `scripts/test-suites/required/20-e2e-dry-run.sh`:

- The script is shard 1 for headless Electron dry-run cases.
- It delegates to `scripts/e2e-dry-run/run-all.sh 'case-1.*.sh'`.
- The concrete case set currently contains 9 scripts:
  - `case-1.1-success.sh`
  - `case-1.2-failure.sh`
  - `case-1.3-cancel.sh`
  - `case-1.4-edit-restart.sh`
  - `case-1.5-fix-approve.sh`
  - `case-1.6-fix-reject.sh`
  - `case-1.7-manual-approve.sh`
  - `case-1.8-manual-reject.sh`
  - `case-1.9-fix-codex-approve.sh`

Evidence in `scripts/run-all-tests.sh`:

- `INVOKER_TEST_ALL_PROOF=1` forces rerun, disables resume checkpoint reuse, and uses an isolated temporary state file unless one is explicitly supplied.
- Required proof mode expects exactly `Executed: 16`.
- Required proof mode expects `Failed: 0`.
- Required proof mode expects `Skipped by checkpoint: 0`.
- Required proof mode expects `Skipped unavailable: 0`.
- `required/20-e2e-dry-run.sh`, `required/21-e2e-dry-run-downstream.sh`, and `required/22-e2e-dry-run-github.sh` are marked parallel-safe for local proof runs.

## Competing Design

Alternative: run all dry-run cases as one monolithic CI command through `pnpm run test:e2e-dry-run` or `bash scripts/e2e-dry-run/run-all.sh`.

Verdict: reject for CI architecture.

Rationale:

- It removes the explicit shard boundaries currently reviewed in `.github/workflows/ci.yml`.
- A single long-running job gives less precise failure attribution than the `dry-run / case-1`, `dry-run / case-2`, and `dry-run / case-4` matrix names.
- It does not match the existing local aggregate proof model, where `scripts/run-all-tests.sh` records individual suite logs and proof thresholds.

The monolithic command remains useful as a local diagnostic for all dry-run cases, but it is not the selected CI structure.

## Deterministic Commands

Run from the repository root after dependencies are installed with `pnpm install --frozen-lockfile`.

### CI shard parity for INV-119

```bash
bash scripts/test-suites/required/20-e2e-dry-run.sh
```

Expected terminal markers:

```text
======== case-1.1-success.sh ========
======== case-1.2-failure.sh ========
======== case-1.3-cancel.sh ========
======== case-1.4-edit-restart.sh ========
======== case-1.5-fix-approve.sh ========
======== case-1.6-fix-reject.sh ========
======== case-1.7-manual-approve.sh ========
======== case-1.8-manual-reject.sh ========
======== case-1.9-fix-codex-approve.sh ========
e2e-dry-run: 9 passed, 0 failed (9 total)
```

Thresholds:

- Exit code must be `0`.
- Passed count must be `9`.
- Failed count must be `0`.
- Total count must be `9`.
- No `No case scripts matched pattern: case-1.*.sh` output is allowed.
- No `FAILED:` output is allowed.

### Required proof harness

```bash
INVOKER_TEST_ALL_PROOF=1 bash scripts/run-all-tests.sh
```

Expected summary:

```text
======== Summary ========
Mode: required
Executed: 16
Failed: 0
Skipped by checkpoint: 0
Skipped unavailable: 0
```

Thresholds:

- Exit code must be `0`.
- `Mode` must be `required`.
- `Executed` must be exactly `16`.
- `Failed` must be exactly `0`.
- `Skipped by checkpoint` must be exactly `0`.
- `Skipped unavailable` must be exactly `0`.
- No `ERROR: INV-67 proof` threshold failure may be emitted.

### CI topology review

```bash
sed -n '1,760p' .github/workflows/ci.yml
sed -n '1,520p' scripts/run-all-tests.sh
sed -n '1,80p' scripts/test-suites/required/20-e2e-dry-run.sh
```

Expected findings:

- `.github/workflows/ci.yml` contains a `dry-run` job with matrix entries for `case-1`, `case-2`, and `case-4`.
- `case-1` maps to `scripts/test-suites/required/20-e2e-dry-run.sh`.
- `scripts/run-all-tests.sh` includes `required/20-e2e-dry-run.sh` in `is_parallel_safe`.
- `scripts/run-all-tests.sh` validates required proof thresholds through `validate_proof_thresholds`.
- `scripts/test-suites/required/20-e2e-dry-run.sh` execs `scripts/e2e-dry-run/run-all.sh 'case-1.*.sh'`.

## Final Verdict

Selected approach accepted.

The current architecture provides reviewable CI shard boundaries while retaining deterministic local proof thresholds. The proof is deterministic because the required proof command disables checkpoint reuse, forces rerun, validates exact suite counts, and fails on any unavailable or failed required suite.
