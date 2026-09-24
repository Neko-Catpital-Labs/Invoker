---
name: failure-triage
description: >
  Triage Invoker workflow/task failures into owned classes before claiming
  autofix will or won't repair them. Trigger on "why so many failures",
  "read the logs", "is autofix going to fix these", "what's failing", or any
  fleet failure audit. Read-only: classifies from recorded state, never
  guesses from workflow names.
---

# failure-triage

Turn a wall of failed workflows into per-class dispositions with named owners.
The expensive mistake this prevents: calling every failure "autofix will get
it" or "a bug" without reading `execution.error`, `execution.failureClass`,
and the autofix decision ledger.

## Procedure

Run the digest first, then chase the classes it surfaces:

```sh
node skills/failure-triage/scripts/failure-digest.mjs            # text digest
node skills/failure-triage/scripts/failure-digest.mjs --json     # structured
```

The digest is read-only. It runs `invoker-cli query workflows/tasks` and folds
`~/.invoker/invoker.log`'s `worker-autofix-*` events. It does not mutate
state, retry anything, or touch git.

Then verify each class against the evidence below before reporting. A digest
bucket is a hypothesis; the cited check is the proof.

## Class → owner table

| Signature in `execution.error` | Class | Owner | Check |
| --- | --- | --- | --- |
| `Installing managed worktree dependencies` present, `Running task payload` absent | ssh-provision-death | infra-repair worker | `execution.failureClass` should be an `ssh-*` class; unset means the classifier missed it — infra-repair never sees it and generic autofix burns its 3-retry budget instead |
| `ERR_MODULE_NOT_FOUND`, `npm ci`/`pnpm install`/`uv sync` needed | missing-deps | `repoProvisionCommands` wiring | confirm the worktree's repo has no lockfile match for the provision guard; check `~/.invoker/config.json` `repoProvisionCommands` covers the repoUrl |
| `carries N review claims, but it would publish as one PR` | merge-gate-multi-claim | human replan | autofix cannot fix plan shape; republish as a workflow chain or split-publish the finished branch. If all non-merge tasks completed, the work is salvageable — split by claim boundary, don't re-run |
| identical deterministic error across many tasks (e.g. `ValueError: ... queue`) | precondition / plan bug | human or upstream data fix | check whether a resubmitted sibling workflow failed identically — if yes, retry is proven futile; the plan's premise is wrong (e.g. enumerated items not in the source of truth) |
| `usage limit` / `rate limit` | usage-limit | quota/backoff | autofix skips these by design; check for a circuit-breaker trip in the log |
| `fatal: invalid reference`, `.invoker/env.sh not a valid identifier`, `No space left on device`, worktree/mirror corrupt | known ssh-infra classes | infra-repair worker | verify `failureClass` was set and infra-repair logged an action; silent infra-repair = wiring/config gap |
| none of the above | code/test failure | autofix (if eligible) | eligible = failed + no `parentTask` + not reconciliation + budget > 0 |

## Autofix verdicts (from `worker-autofix-*` log events)

- `not-eligible` with `hasParentTask: true` — child/fanout task; autofix
  excludes children by design (`auto-fix-recovery.ts`). It will never retry
  these; the parent task or a human owns the fix.
- `worker-retry-budget-exhausted` — already burned `autoFixRetries` (default
  3) fix-with-agent attempts. Permanently parked until manually retried or
  the workflow is resubmitted.
- `already-queued-intent` — a fix intent is in flight; wait for it.
- `worker-autofix-submitted` — fix-with-agent intent dispatched this scan.
- `usage-limit` — global circuit breaker; nothing retries until quota resets.

## Retry semantics that bite

- `retry-task`/`retry` reset **failed/stuck** tasks only; completed
  dependencies keep their commits. A downstream task inherits its dep's
  `execution.commit` as its base (`collectUpstreamBase`). If the dep was
  built on a stale/broken base, retrying the leaf fails identically —
  retry the completed dep (its rerun gets a fresh base) or resubmit.
- Resubmitting an unchanged plan reproduces the same failure. Check for a
  same-named prior workflow that died the same way before recommending
  resubmit — two identical death signatures = proven-futile retry.
- `needs_input` is a stop, not a failure: it is a real human choice only
  when the trace finds one (e.g. experiment reconciliation selection).

## Proving clone/base staleness (the stale-mirror class)

When provision dies on SSH for a repo the provision script should exist in:

1. `invoker-cli query workflow <id>` → `repoUrl`. The remote clone dir is
   `~/.invoker/repos/<computeRepoUrlHash(repoUrl)>`; different URL spellings
   (`git@` vs `https`, fork vs upstream, trailing `.git`) hash to different
   clones with independent staleness.
2. SSH to the pool member (`remoteTargets` in `~/.invoker/config.json`),
   `git -C <clone> log -1 --format=%cs` — a clone months behind its branch
   tips is the suspect.
3. Prove the worktree's base, not just the clone:
   `git -C <clone> merge-base --is-ancestor <commit-that-added-file> <worktree-HEAD>`
   — exit 1 means the checked-out branch predates the file. Fresh task
   commits on stale bases are the signature.
4. Fix: repoint `origin` to the canonical remote + `fetch` + `reset --hard`
   (the executor runs `git fetch --all` at task start, so a repointed clone
   heals itself on the next task) — or sync the source repo itself.
   `git ls-remote <url> refs/heads/<branch>` tells you whether the remote
   tip itself is abandoned.

## Report shape

Per class: count, example task id, root cause (one line, cited), owner,
and whether autofix/infra-repair already engaged (log verdict) or
structurally cannot. End with what actually unblocks each class — never
"autofix will handle it" for a class the log shows it already skipped or
exhausted.

## Non-goals

No retries, mutations, or PRs from this skill — it produces the triage and
the recommended owner. Repairs go through `invoker-ops` (retry/resume),
`plan-to-invoker` (resubmits), or a code-fix plan.
