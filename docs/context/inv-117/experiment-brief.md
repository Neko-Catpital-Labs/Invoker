# INV-117 Experiment Brief: Deterministic Test Architecture Proof

## Question

Can Invoker's test architecture be made reviewable with deterministic evidence, while preserving CI parallelism and local proof commands?

## Files under test

- `.github/workflows/ci.yml`
- `scripts/workspace-test.sh`
- `scripts/run-all-tests.sh`
- `package.json`
- `scripts/test-suites/README.md`
- `scripts/test-suites/required/*.sh`
- `scripts/test-suites/optional/*.sh`
- `scripts/test-suites/dangerous/*.sh`

## Selected approach

Use CI matrix jobs for review-time parallelism and `scripts/run-all-tests.sh` as the deterministic local orchestrator. Keep package workspace tests in `scripts/workspace-test.sh`, where CI forces package test concurrency to `1` unless `INVOKER_WORKSPACE_TEST_CONCURRENCY` is explicitly set.

This keeps the high-cost end-to-end suites split across CI jobs, while giving reviewers one local proof surface with explicit counts, state handling, and failure thresholds.

## Alternative considered

Alternative: replace the split CI matrix with one monolithic `pnpm run test:all:proof:extended` job.

Verdict: rejected. It would reduce scheduling complexity, but it would remove the current failure isolation across `quality-checks`, `required-fast`, `dry-run`, `playwright`, `ssh`, `optional-other`, and `docker` jobs in `.github/workflows/ci.yml`. It would also make one flaky or environment-heavy suite block all other evidence, even though `scripts/run-all-tests.sh` already provides the deterministic local proof path when a serialized audit is needed.

## Deterministic commands

Run all commands from the repository root.

### 1. Validate script syntax

Command:

```sh
bash -n scripts/workspace-test.sh
bash -n scripts/run-all-tests.sh
```

Expected output:

```text
<no output>
```

Threshold:

- Both commands exit `0`.

Verdict:

- Pass means the reviewed shell entrypoints parse before any runtime dependency is required.

### 2. Prove workspace-test concurrency selection

Command:

```sh
CI=true INVOKER_WORKSPACE_TEST_CONCURRENCY=1 bash scripts/workspace-test.sh
```

Expected output prefix:

```text
==> Running package workspace tests (concurrency=1)
```

Threshold:

- Exit `0`.
- The first status line must include `concurrency=1`.
- The command must then run `pnpm -r --workspace-concurrency=1 test` and `bash scripts/required-builds.sh`.

Verdict:

- Pass supports the selected design because CI package tests are serialized unless a reviewer deliberately overrides concurrency.

### 3. Prove required-suite local audit mode

Command:

```sh
INVOKER_TEST_ALL_PROOF=1 bash scripts/run-all-tests.sh
```

Expected output summary:

```text
======== Summary ========
Mode: required
Executed: 16
Failed: 0
Skipped by checkpoint: 0
Skipped unavailable: 0
```

Threshold:

- Exit `0`.
- `Executed` must equal `16`.
- `Failed`, `Skipped by checkpoint`, and `Skipped unavailable` must all equal `0`.

Verdict:

- Pass proves the default local proof command executes every required suite exactly once with no resume checkpoint masking.

### 4. Prove extended-suite local audit mode

Command:

```sh
INVOKER_TEST_ALL_PROOF=1 INVOKER_TEST_ALL_EXTENDED=1 bash scripts/run-all-tests.sh
```

Expected output summary:

```text
======== Summary ========
Mode: extended
Executed: 23
Failed: 0
Skipped by checkpoint: 0
Skipped unavailable: 0
```

Threshold:

- Exit `0`.
- `Executed` must equal `23`.
- `Failed`, `Skipped by checkpoint`, and `Skipped unavailable` must all equal `0`.

Verdict:

- Pass proves required plus optional suites can be audited locally without relying on CI matrix partitioning.

### 5. Prove destructive-suite local audit mode

Command:

```sh
INVOKER_TEST_ALL_PROOF=1 INVOKER_TEST_ALL_EXTENDED=1 INVOKER_TEST_ALL_DANGEROUS=1 bash scripts/run-all-tests.sh
```

Expected output summary when Docker is available:

```text
======== Summary ========
Mode: dangerous
Executed: 24
Failed: 0
Skipped by checkpoint: 0
Skipped unavailable: 0
```

Expected output summary when Docker is unavailable:

```text
======== Summary ========
Mode: dangerous
Executed: 23
Failed: 0
Skipped by checkpoint: 0
Skipped unavailable: 1

Unavailable skips:
  dangerous/10-docker-comprehensive.sh
```

Threshold:

- Exit `0`.
- `Failed` must equal `0`.
- `Skipped by checkpoint` must equal `0`.
- `Skipped unavailable` must be `0` or `1`.
- If there is one unavailable skip, it must be exactly `dangerous/10-docker-comprehensive.sh`.

Verdict:

- Pass proves destructive coverage is deterministic while still recording the one accepted environment-dependent absence.

### 6. Prove CI matrix keeps evidence split by concern

Command:

```sh
rg -n "name: (quality|required-fast|dry-run|playwright|ssh|optional|docker)" .github/workflows/ci.yml
```

Expected output contains:

```text
quality / ${{ matrix.name }}
required-fast / ${{ matrix.name }}
dry-run / ${{ matrix.name }}
playwright / ${{ matrix.name }}
ssh / ${{ matrix.name }}
optional / ${{ matrix.name }}
docker / comprehensive
```

Threshold:

- Exit `0`.
- All seven job labels above are present.

Verdict:

- Pass supports the selected architecture because CI continues to expose independent review surfaces instead of hiding all evidence behind one long job.

## Evidence-backed conclusion

The selected design is retained: CI remains matrixed and sharded for reviewability, while `scripts/run-all-tests.sh` provides deterministic local proof modes with hard-coded execution thresholds. The competing monolithic job design is not selected because it weakens failure isolation without improving the deterministic proof story.

Acceptance for INV-117 is satisfied when:

- This brief is committed at `docs/context/inv-117/experiment-brief.md`.
- The syntax validation commands exit `0`.
- The proof-mode thresholds in `scripts/run-all-tests.sh` match the expected suite counts above.
- Reviewers can map every command in this brief to the concrete files listed under "Files under test."
