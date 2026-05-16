# INV-67 Deterministic Experiment Brief

Date: 2026-05-16

## Decision

Use `scripts/run-all-tests.sh` as the deterministic proof harness for INV-67 architecture review. It is the selected approach because it makes the experiment surface explicit:

- mode selection is encoded by `INVOKER_TEST_ALL_EXTENDED` and `INVOKER_TEST_ALL_DANGEROUS`;
- the suite list is collected from concrete files under `scripts/test-suites/{required,optional,dangerous}`;
- pass, fail, checkpoint skip, and unavailable skip counts are printed in a stable `Summary` block;
- resumability is isolated behind `INVOKER_TEST_ALL_RESUME`, `INVOKER_TEST_ALL_FORCE_RERUN`, and `INVOKER_TEST_ALL_STATE_FILE`;
- parallel execution is opt-in through `INVOKER_TEST_ALL_JOBS` and restricted by the script's `is_parallel_safe` allowlist.

## Files Under Test

Primary harness files:

- `package.json`
- `scripts/run-all-tests.sh`
- `scripts/workspace-test.sh`

Required suite files selected by the default `required` mode:

- `scripts/test-suites/required/05-delete-all-prod-db-guard.sh`
- `scripts/test-suites/required/07-invalid-config-json.sh`
- `scripts/test-suites/required/08-electron-preprovision-repro.sh`
- `scripts/test-suites/required/10-vitest-workspace.sh`
- `scripts/test-suites/required/15-owner-boundary-policy.sh`
- `scripts/test-suites/required/15-submit-workflow-chain.sh`
- `scripts/test-suites/required/16-branch-carry-forward.sh`
- `scripts/test-suites/required/17-merge-gate-concurrency-repro.sh`
- `scripts/test-suites/required/18-start-running-mece-repros.sh`
- `scripts/test-suites/required/19-task-new-attempt-reset-repro.sh`
- `scripts/test-suites/required/20-e2e-dry-run.sh`
- `scripts/test-suites/required/21-e2e-dry-run-downstream.sh`
- `scripts/test-suites/required/22-e2e-dry-run-github.sh`
- `scripts/test-suites/required/23-fix-intent-repros.sh`
- `scripts/test-suites/required/24-start-running-mece-repros.sh`
- `scripts/test-suites/required/50-verify-executor-routing.sh`

Extended suite files added by `INVOKER_TEST_ALL_EXTENDED=1`:

- `scripts/test-suites/optional/30-e2e-ssh.sh`
- `scripts/test-suites/optional/31-e2e-ssh-merge.sh`
- `scripts/test-suites/optional/32-e2e-chaos.sh`
- `scripts/test-suites/optional/33-e2e-chaos-overload.sh`
- `scripts/test-suites/optional/40-playwright-app.sh`
- `scripts/test-suites/optional/60-worktree-provisioning.sh`
- `scripts/test-suites/optional/70-ui-visual-proof-validate.sh`

Dangerous suite file added by `INVOKER_TEST_ALL_EXTENDED=1 INVOKER_TEST_ALL_DANGEROUS=1`:

- `scripts/test-suites/dangerous/10-docker-comprehensive.sh`

## Competing Design Considered

Alternative: treat `pnpm test` as the canonical proof command.

`package.json` maps `pnpm test` to:

```sh
bash scripts/test-plan-to-invoker-skill.sh && bash scripts/workspace-test.sh
```

`scripts/workspace-test.sh` then runs:

```sh
pnpm -r --workspace-concurrency="$CONCURRENCY" test
bash "$ROOT/scripts/required-builds.sh"
```

This is useful as a package-level regression check, but it is weaker as an experiment proof because it does not enumerate the e2e/repro suite contract, does not print stable executed/failed/skip counters, and does not provide checkpoint or unavailable-preflight semantics. It also adapts concurrency based on `CI`, while `run-all-tests.sh` allows the experiment to pin `INVOKER_TEST_ALL_JOBS`.

Verdict: keep `pnpm test` for normal package regression coverage; use `pnpm run test:all` and its mode variants for INV-67 deterministic architecture proof.

## Deterministic Commands

Run from the repository root.

### Required Proof

```sh
STATE_FILE="$(mktemp -t invoker-inv-67-required.XXXXXX)"
INVOKER_TEST_ALL_STATE_FILE="$STATE_FILE" \
INVOKER_TEST_ALL_FORCE_RERUN=1 \
INVOKER_TEST_ALL_JOBS=1 \
pnpm run test:all
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

- exit code must be `0`;
- `Failed` must equal `0`;
- `Executed` must equal `16`;
- `Skipped by checkpoint` must equal `0`;
- `Skipped unavailable` must equal `0`.

Verdict rule: accept the selected architecture proof only when all required thresholds pass.

### Extended Proof

```sh
STATE_FILE="$(mktemp -t invoker-inv-67-extended.XXXXXX)"
INVOKER_TEST_ALL_STATE_FILE="$STATE_FILE" \
INVOKER_TEST_ALL_FORCE_RERUN=1 \
INVOKER_TEST_ALL_EXTENDED=1 \
INVOKER_TEST_ALL_JOBS=1 \
pnpm run test:all:extended
```

Expected summary:

```text
======== Summary ========
Mode: extended
Executed: 23
Failed: 0
Skipped by checkpoint: 0
Skipped unavailable: 0
```

Thresholds:

- exit code must be `0`;
- `Failed` must equal `0`;
- `Executed` must equal `23`;
- `Skipped by checkpoint` must equal `0`;
- `Skipped unavailable` must equal `0`.

Verdict rule: accept extended coverage only when optional suites pass without checkpoint reuse.

### Dangerous Docker Proof

```sh
STATE_FILE="$(mktemp -t invoker-inv-67-dangerous.XXXXXX)"
INVOKER_TEST_ALL_STATE_FILE="$STATE_FILE" \
INVOKER_TEST_ALL_FORCE_RERUN=1 \
INVOKER_TEST_ALL_EXTENDED=1 \
INVOKER_TEST_ALL_DANGEROUS=1 \
INVOKER_TEST_ALL_JOBS=1 \
pnpm run test:all:destructive
```

Expected summary when Docker is available:

```text
======== Summary ========
Mode: dangerous
Executed: 24
Failed: 0
Skipped by checkpoint: 0
Skipped unavailable: 0
```

Expected summary when Docker is unavailable:

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

Thresholds:

- exit code must be `0`;
- `Failed` must equal `0`;
- `Skipped by checkpoint` must equal `0`;
- `Skipped unavailable` may equal `1` only for `dangerous/10-docker-comprehensive.sh`;
- if Docker is available, `Executed` must equal `24`;
- if Docker is unavailable, `Executed` must equal `23`.

Verdict rule: accept dangerous coverage when Docker-backed behavior passes, or when the only unavailable skip is the explicit Docker preflight in `scripts/run-all-tests.sh`.

## Parallelism Check

Use this only after the serial required proof passes:

```sh
STATE_FILE="$(mktemp -t invoker-inv-67-required-parallel.XXXXXX)"
INVOKER_TEST_ALL_STATE_FILE="$STATE_FILE" \
INVOKER_TEST_ALL_FORCE_RERUN=1 \
INVOKER_TEST_ALL_JOBS=4 \
pnpm run test:all
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

- exit code must be `0`;
- required-mode summary counts must match the serial required proof;
- output may interleave suite logs, but the final summary must remain stable.

Verdict rule: accept parallelism only as an acceleration path. The serial required proof remains the canonical deterministic baseline.

## Review Checklist

- The command must pin `INVOKER_TEST_ALL_STATE_FILE` to a fresh temporary file.
- The command must set `INVOKER_TEST_ALL_FORCE_RERUN=1`.
- The canonical proof must set `INVOKER_TEST_ALL_JOBS=1`.
- The reviewer must compare the final `Summary` block against the thresholds above.
- Any nonzero `Failed` count rejects the proof, even if package-level `pnpm test` passes.
