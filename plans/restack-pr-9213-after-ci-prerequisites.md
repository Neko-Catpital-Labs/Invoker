# Restack PR #9213 after CI prerequisites

## Diagnosis

The merge-queue `build-artifacts` job failed during `pnpm install` because
`node-pty` had no Node 26 prebuild and fell back to `node-gyp`, whose runner
environment lacked `make`. PR #9213 changes only the ci-regression-watch
formula, so adding shared runner provisioning to it would mix review claims.

PR #9209 already adds `make` and `g++` before dependency installation and
updates `scripts/test-ci-workflow-merge-queue-policy.mjs`. That assertion fails
against master and passes on the prerequisite branch. PR #9209 is stacked on
PR #9231, which independently repairs the other failing UI Vitest bootstrap.

## Plan

Restack PR #9213 above the existing prerequisite chain, preserving the formula
file from commit `11f7c651308761724e4a3507db9b23948470e9bb` byte-for-byte.

Review claim: PR #9213 keeps its exact one-file formula change while depending
on the isolated CI prerequisites in PRs #9231 and #9209.

Review lane: docs

Safety invariant: The formula blob remains identical to the original PR head;
no shared CI workflow, prerequisite patch, or product file changes in this
slice.

Slice rationale: Dependency ordering is the only new claim. The UI bootstrap
and build-artifacts fixes remain in their existing policy PRs.

Architectural effect: Branch ancestry changes from `master -> #9213` to
`master -> #9231 -> #9209 -> #9213`; formula behavior remains unchanged.

Alternative considerations: Editing CI policy into #9213 and duplicating
#9209 are rejected because they mix or duplicate review claims.

Non-goals: No CI-policy implementation, product edits, formula redesign, or
unrelated cleanup.

## Verification

- Run `bash skills/plan-to-invoker/scripts/formula-doctor.sh ci-regression-watch`.
- Require the prerequisite-base diff to name only the formula workflow file.
- Require that file's Git blob to equal the same path at the original PR head.
