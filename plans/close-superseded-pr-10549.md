# Close superseded repair-bot PR #10549

## Goal

Close GitHub PR #10549 without merging, because its content is fully
superseded by already-merged PR #10541 (commit `49b7394ff`).

## Motivation

PR #10549 was asked to be rebased onto `master`. The rebase fails with
add/add conflicts on `scripts/bootstrap.sh`,
`scripts/capture-install-transcript.sh`, `scripts/test-bootstrap.sh`, and
`scripts/test-install-transcript.sh`, because PR #10541 already merged an
independently-written version of the exact same feature ("Add Node
bootstrap wrapper that delegates to invoker-cli install") to `master`.

Diffing PR #10549's head (`0aa1f8f26201651f918ec5cc59c1bdaaf944109e`)
against `master`'s merged version confirms PR #10549 has no unique content:

- The two non-conflicting files it also touched
  (`scripts/review-unit-rules.mjs`, `scripts/test-review-unit-classification.mjs`)
  are byte-identical to `master`.
- Its four conflicting files are a strict subset of `master`'s: `master`
  additionally has a `run_nodesource_setup` helper (downloads the NodeSource
  setup script to a file and validates it before running, instead of piping
  `curl` straight into a privileged `sudo bash`) and a post-install Node
  major-version mismatch check, plus the tests for both. PR #10549 lacks
  both hardenings.

There is nothing to cherry-pick and no restructuring that keeps any of
PR #10549's own code — the correct fix is to close it as superseded, not
force a resolution that reintroduces a weaker, already-superseded
implementation.

## Safety invariant

Closing PR #10549 does not touch `master` or any other open PR, does not
merge or delete its branch, and does not modify code. It is a metadata-only,
reversible GitHub action (the PR can be reopened).

## Verify

`gh pr view 10549 --json state -q .state` returns `CLOSED` after the task
runs, and the two non-conflicting files remain byte-identical to `master`
at close time (re-checked immediately before closing, in case `master`
moved).

## Plan

Single command-only workflow, `onFinish: none` (no code change), that:

1. Re-verifies PR #10549 has no unique content vs. current `master`.
2. Closes PR #10549 with an explanatory comment citing #10541 /
   `49b7394ff`, gated on manual approval since it's a visible action on
   shared GitHub state.
