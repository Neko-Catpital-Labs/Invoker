# Git e2e master-head repro coverage

**Date:** 2026-07-19
**Observed revision:** `origin/master` at `04f96f630`
**Review claim:** Add deterministic root-cause repro coverage for the git e2e failures observed on master before changing behavior.
**Safety invariant:** These scripts and notes do not change runtime control flow or weaken e2e assertions.
**Architectural effect:** Adds local proof harnesses and incident documentation only.

Local probing of master found two active e2e failure causes and one disabled guard in the required reset shard. This note records how to reproduce each issue before any behavior fix lands.

## 1. `run.sh --headless delete-all` bootstraps despite preprovisioned artifacts

**Root cause:** `run.sh` treats a missing `node_modules/.invoker-bootstrap-stamp` as a stale workspace install even when the preprovisioned artifacts it checks are healthy:

- `node_modules/.modules.yaml`
- executable `packages/app/node_modules/.bin/electron`
- working `node_modules/.bin/tsup --version`

The result is that e2e cases which begin with `./run.sh --headless delete-all`, including case 2.15 and case 2.16, can re-run `pnpm install --frozen-lockfile` in an already provisioned checkout if only the private stamp is absent.

**Current bug repro:**

```bash
bash scripts/repro/repro-run-sh-preprovisioned-bootstrap.sh --expect-bug
```

**Expected failing signature:** the repro exits 0 only when the temp `run.sh` fixture calls the `pnpm` stub with `install --frozen-lockfile` while the bootstrap artifacts are present and the stamp is absent.

**Later fixed-mode command:**

```bash
bash scripts/repro/repro-run-sh-preprovisioned-bootstrap.sh --expect-fixed
```

## 2. Required merge-gate concurrency proof runs zero active tests

**Root cause:** `scripts/test-suites/required/17-merge-gate-concurrency-repro.sh` still targets:

```text
packages/execution-engine/src/__tests__/task-runner.test.ts
```

The filtered test now lives in:

```text
packages/execution-engine/src/__tests__/task-runner-fix-publish-and-ssh.test.ts
```

So the required proof selects the old file and applies a test-name filter that matches zero active tests.

**Current bug repro:**

```bash
bash scripts/repro/repro-required-vitest-filter-zero-active.sh --expect-bug
```

**Expected failing signature:** the repro exits 0 only when required/17 targets `task-runner.test.ts`, that target has zero matches for `starts an independent merge gate while another merge gate is still preparing review`, and the relocated file contains the matching test.

**Later fixed-mode command:**

```bash
bash scripts/repro/repro-required-vitest-filter-zero-active.sh --expect-fixed
```

## 3. Required downstream reset shard quarantines case 2.15 and case 2.16 on merge-queue refs

**Root cause:** `scripts/test-suites/required/21-e2e-dry-run-downstream-reset.sh` has a merge-queue branch for:

```text
GITHUB_EVENT_NAME=pull_request
GITHUB_HEAD_REF=mergify/merge-queue/*
```

That branch omits:

- `case-2.15-recreate-preempt-attempt-refresh.sh`
- `case-2.16-retry-vs-recreate-five-second-window.sh`

The non-merge-queue path still runs both cases, so the disabled guard is hidden only on Mergify merge-queue refs.

**Current bug repros:**

```bash
bash scripts/repro/prove-reset-assertions.sh --expect-bug
bash scripts/repro/prove-reset-rulebook.sh --expect-bug
```

**Expected failing signature:** each repro exits 0 only when the required reset shard contains a merge-queue branch that omits its case while the default shard still includes it. The scripts print the full merge-queue reproduction command:

```bash
GITHUB_EVENT_NAME=pull_request GITHUB_HEAD_REF=mergify/merge-queue/repro bash scripts/test-suites/required/21-e2e-dry-run-downstream-reset.sh
```

**Later fixed-mode commands:**

```bash
bash scripts/repro/prove-reset-assertions.sh
bash scripts/repro/prove-reset-rulebook.sh
```
