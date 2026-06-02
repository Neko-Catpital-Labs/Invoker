# INV-117 Experiment Brief: Deterministic Test Proof

Date: 2026-06-02

## Goal

Establish deterministic experiment proof for INV-117 so architecture choices are evidence-backed, reviewable, and reproducible from source-controlled commands.

## Files under test

- `.github/workflows/ci.yml`
- `package.json`
- `scripts/workspace-test.sh`
- `scripts/run-all-tests.sh`
- `scripts/test-suites/README.md`
- `scripts/test-suites/required/*.sh`
- `scripts/test-suites/optional/*.sh`
- `scripts/test-suites/dangerous/*.sh`

## Architecture choice under test

Selected approach: use the repo-owned test orchestrator, `scripts/run-all-tests.sh`, with proof mode enabled by the package scripts in `package.json`.

Proof mode is selected because it converts a normal test run into a deterministic evidence artifact:

- `INVOKER_TEST_ALL_PROOF=1` forces a fresh proof run by setting `FORCE_RERUN=1`.
- Proof mode disables resume by setting `RESUME=0`.
- Proof mode validates exact suite counters before returning success.
- The proof threshold is implemented next to suite discovery, not in a separate parser.
- CI still remains the integration authority through `.github/workflows/ci.yml`.

## Competing design considered

Alternative: use GitHub Actions job success in `.github/workflows/ci.yml` as the only proof source.

Verdict: rejected for INV-117 proof.

Reason: CI job success proves the hosted matrix completed, but it does not give reviewers a local deterministic command with exact expected summary counters. The selected approach keeps CI coverage while adding a source-controlled local proof surface:

- CI-only proof is environment-dependent and split across multiple matrix jobs.
- CI-only proof does not expose one local command that validates suite discovery counts.
- CI-only proof is still necessary for hosted parity, but insufficient as a deterministic experiment artifact.

## Deterministic commands

Run all commands from the repository root.

### 1. Confirm CI architecture

Command:

```sh
sed -n '1,780p' .github/workflows/ci.yml
```

Expected output anchors:

```text
NODE_VERSION: '26'
pnpm install --frozen-lockfile
pnpm --filter @invoker/ui build
pnpm --filter @invoker/app build
pnpm run check:deps
pnpm run check:required-builds
pnpm run check:types
bash scripts/test-suites/required/10-vitest-workspace.sh
bash scripts/test-suites/optional/40-playwright-app.sh
bash scripts/test-suites/dangerous/10-docker-comprehensive.sh
```

Threshold:

- All anchors must appear.
- CI must build UI/app artifacts before test jobs consume them.
- CI must include required, optional, Playwright, SSH, dry-run, and dangerous Docker surfaces.

Verdict if threshold passes: CI is a broad integration gate, but not the only deterministic proof mechanism.

### 2. Confirm workspace test determinism

Command:

```sh
CI=true INVOKER_WORKSPACE_TEST_CONCURRENCY=1 bash scripts/workspace-test.sh
```

Expected output anchors:

```text
==> Running package workspace tests (concurrency=1)
==> Running required package builds
```

Expected exit status: `0`.

Threshold:

- Concurrency must be exactly `1`.
- Workspace tests must run before required package builds.
- Any non-zero exit fails the proof.

Verdict if threshold passes: package-level verification is deterministic under the same single-worker behavior used by CI.

### 3. Confirm required proof mode

Command:

```sh
pnpm run test:all:proof
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

Expected exit status: `0`.

Threshold:

- `Executed` must equal `16`.
- `Failed` must equal `0`.
- `Skipped by checkpoint` must equal `0`.
- `Skipped unavailable` must equal `0`.

Verdict if threshold passes: required test discovery is deterministic and proves every required suite ran from scratch.

### 4. Confirm extended proof mode

Command:

```sh
pnpm run test:all:proof:extended
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

Expected exit status: `0`.

Threshold:

- `Executed` must equal `23`.
- `Failed` must equal `0`.
- `Skipped by checkpoint` must equal `0`.
- `Skipped unavailable` must equal `0`.

Verdict if threshold passes: optional suite discovery is deterministic and extends the required proof without checkpoint skips.

### 5. Confirm destructive proof mode

Command:

```sh
pnpm run test:all:proof:destructive
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

Expected exit status: `0`.

Threshold:

- `Failed` must equal `0`.
- `Skipped by checkpoint` must equal `0`.
- `Skipped unavailable` may be `0` or `1`.
- The only allowed unavailable skip is `dangerous/10-docker-comprehensive.sh`.
- If Docker is available, `Executed` must equal `24`.
- If Docker is unavailable, `Executed` must equal `23`.

Verdict if threshold passes: destructive coverage is deterministic while still distinguishing unavailable infrastructure from test failure.

## Final verdict criteria

INV-117 experiment proof passes only when:

- The CI architecture anchors in `.github/workflows/ci.yml` are present.
- `scripts/workspace-test.sh` exits `0` with single-worker concurrency.
- `pnpm run test:all:proof` exits `0` with exact required counters.
- `pnpm run test:all:proof:extended` exits `0` with exact extended counters.
- `pnpm run test:all:proof:destructive` exits `0` with exact dangerous counters or the one explicitly allowed Docker-unavailable skip.

If any command exits non-zero, any expected anchor is missing, or any threshold is not met, the architecture choice is not proven for INV-117.
